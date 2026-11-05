import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startBridge } from "../../src/host/server/transport/bridge.ts";
import { NodeTelemetry } from "../../src/platform/telemetry/telemetry.ts";
import { terminalHost } from "../helpers/terminal-host.ts";
import type { ActivityHostApi, ActivityItem, ActivitySnapshot } from "../../src/plugins/builtin/activity/contract/activity.ts";

const runningShell: ActivityItem = { id: "task-1", source: "background-tasks", kind: "shell", title: "Build desktop package", status: "running", startedAt: 1000, updatedAt: 1000, endedAt: null, currentAction: "npm run desktop:package", canStop: true, canRerun: false, canOpen: true };
const finishedAgent: ActivityItem = { id: "run-1", source: "subagents", kind: "workflow", title: "Research MR", status: "completed", startedAt: 500, updatedAt: 900, endedAt: 900, model: "kimi/k2", tokens: 28_000, canStop: false, canRerun: false, canOpen: true };

for (const width of [1440, 390]) test(`activity shows live running and finished work at ${width}px`, async ({ page }, testInfo) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-activity-browser-"));
  const { host } = terminalHost(directory);
  let items = [runningShell, finishedAgent];
  let revision = 1;
  const listeners = new Set<(snapshot: ActivitySnapshot) => void>();
  const snapshot = (): ActivitySnapshot => ({ version: 1, revision, observedAt: 2000, items, providers: [{ source: "background-tasks", available: true }, { source: "subagents", available: true }] });
  const publish = () => { revision++; for (const listener of listeners) listener(snapshot()); };
  const activity: ActivityHostApi = {
    snapshot: async () => snapshot(),
    subscribe: (_sessionId, listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    detail: async target => ({ item: items.find(item => item.source === target.source && item.id === target.id)!, text: target.id === "task-1" ? "Compiling renderer…\n4 tests passing" : "Research complete", truncated: false }),
    stop: async target => { items = items.map(item => item.source === target.source && item.id === target.id ? { ...item, status: "stopped", endedAt: 1900, canStop: false } : item); publish(); return snapshot(); },
    rerun: async () => snapshot(),
  };
  host.activity = activity;
  const bridge = await startBridge(host, fileURLToPath(new URL("../../web/dist/", import.meta.url)), new NodeTelemetry({ env: { PI_WEB_SENTRY_ENABLED: "false" }, monitor: false }), { pluginSettingsFile: join(directory, "plugins.json") });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("dialog", dialog => { void dialog.accept(); });
  await page.addInitScript(theme => { localStorage.setItem("pi-web-locale", "en"); localStorage.setItem("pi-web-theme", theme); }, width < 768 ? "dark" : "light");
  await page.setViewportSize({ width, height: 900 });
  const panel = page.locator("[data-sidebar-right-session]");
  try {
    await page.goto(bridge.url);
    const indicator = page.locator("[data-background-activity]");
    await expect(indicator).toHaveText("Background · 1 task");
    await indicator.click();
    await expect(panel.getByRole("tab", { name: /^Tasks/ })).toBeVisible();
    await expect(panel.getByRole("button", { name: /^running Build desktop package/ })).toBeVisible();
    await expect(panel.getByRole("button", { name: /^running Build desktop package/ })).toBeVisible();
    await expect(panel.getByRole("button", { name: /^completed Research MR/ })).toBeVisible();
    await expect(panel.getByText("28k tokens", { exact: true })).toBeVisible();

    items = [...items, { id: "run-2", source: "subagents", kind: "agent", title: "Reviewer", status: "running", startedAt: 1500, updatedAt: 1500, endedAt: null, currentAction: "Reading auth.ts", canStop: true, canRerun: false, canOpen: true }];
    publish();
    await expect(panel.getByRole("button", { name: /^running Reviewer/ })).toBeVisible();
    await expect(panel.getByText("2 running", { exact: true })).toBeVisible();
    await expect(indicator).toHaveText("Background · 2 tasks");

    await panel.getByRole("button", { name: /^running Build desktop package/ }).click();
    await expect(panel.locator("pre:visible")).toContainText("4 tests passing");
    await panel.getByRole("button", { name: "Stop Build desktop package", exact: true }).click();
    await expect(panel.getByRole("button", { name: /Finished/ })).toContainText("2");
    await expect(panel.getByRole("button", { name: "Stop Build desktop package", exact: true })).toHaveCount(0);
    await expect(indicator).toHaveText("Background · 1 task");

    await panel.getByRole("button", { name: /Finished/ }).click();
    await expect(panel.getByRole("button", { name: /^completed Research MR/ })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`activity-${width}.png`), animations: "disabled" });
    items = items.filter(item => item.status !== "running");
    publish();
    await expect(indicator).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    try { if (!page.isClosed()) await page.goto("about:blank"); }
    finally { await bridge.close(); await rm(directory, { recursive: true, force: true }); }
  }
});
