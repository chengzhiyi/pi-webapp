import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startBridge } from "../../src/host/server/transport/bridge.ts";
import { NodeTelemetry } from "../../src/platform/telemetry/telemetry.ts";
import { terminalHost } from "../helpers/terminal-host.ts";

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-plugin-sync-"));
  const { host } = terminalHost(cwd);
  const bridge = await startBridge(host, fileURLToPath(new URL("../../web/dist", import.meta.url)), new NodeTelemetry({ env: { PI_WEB_SENTRY_ENABLED: "false" }, monitor: false }), { pluginSettingsFile: join(cwd, "plugins.json") });
  return { cwd, bridge };
}

test("plugin switches synchronize management pages without reloading either browser", async ({ page, context }) => {
  const { cwd, bridge } = await fixture();
  const other = await context.newPage();
  for (const p of [page, other]) await p.addInitScript(() => localStorage.setItem("pi-web-locale", "en"));
  try {
    for (const p of [page, other]) {
      await p.goto(bridge.url);
      await p.getByRole("button", { name: "Plugin manager", exact: true }).click();
      await expect(p.getByRole("switch", { name: "Enable Git", exact: true })).toBeChecked();
    }
    await other.evaluate(() => { (window as typeof window & { retainedMarker?: string }).retainedMarker = "same-document"; });
    await page.getByRole("switch", { name: "Enable Git", exact: true }).click();
    await expect(page.getByRole("switch", { name: "Enable Git", exact: true })).not.toBeChecked();
    await expect(other.getByRole("switch", { name: "Enable Git", exact: true })).not.toBeChecked();
    expect(await other.evaluate(() => (window as typeof window & { retainedMarker?: string }).retainedMarker)).toBe("same-document");
  } finally { await other.close(); await page.goto("about:blank"); await bridge.close(); await rm(cwd, { recursive: true, force: true }); }
});

test("a lost toggle response is never replayed and refresh recovers durable state", async ({ page }) => {
  const { cwd, bridge } = await fixture();
  await page.addInitScript(() => localStorage.setItem("pi-web-locale", "en"));
  let mutations = 0;
  try {
    await page.goto(bridge.url);
    await page.getByRole("button", { name: "Plugin manager", exact: true }).click();
    const toggle = page.getByRole("switch", { name: "Enable Git", exact: true });
    await expect(toggle).toBeChecked();
    await page.route("**/api/plugin-management", async route => {
      if (route.request().method() !== "POST") { await route.continue(); return; }
      mutations++;
      await route.fetch();
      await route.abort("failed");
    });
    await toggle.click();
    await expect(page.getByRole("alert")).toContainText("not retried automatically");
    await page.getByRole("button", { name: "Refresh plugins", exact: true }).click();
    await expect(toggle).not.toBeChecked();
    expect(mutations).toBe(1);
  } finally { await page.goto("about:blank"); await bridge.close(); await rm(cwd, { recursive: true, force: true }); }
});

for (const phase of ["initial", "refresh"]) test(`a plugin invalidation during a delayed ${phase} read is consumed after the read`, async ({ page, context }) => {
  const { cwd, bridge } = await fixture();
  const other = await context.newPage();
  for (const p of [page, other]) await p.addInitScript(() => localStorage.setItem("pi-web-locale", "en"));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let intercepted!: () => void;
  const reading = new Promise<void>(resolve => { intercepted = resolve; });
  let held = false;
  try {
    await page.goto(bridge.url);
    await expect(page.getByRole("textbox", { name: "Send a message to the current Pi session" })).toBeEnabled();
    if (phase === "refresh") {
      await page.getByRole("button", { name: "Plugin manager", exact: true }).click();
      await expect(page.getByRole("switch", { name: "Enable Git", exact: true })).toBeChecked();
    }
    await page.route("**/api/plugin-management", async route => {
      if (held || route.request().method() !== "GET") { await route.continue(); return; }
      held = true;
      const old = await route.fetch();
      intercepted(); await gate;
      await route.fulfill({ response: old });
    });
    if (phase === "initial") await page.getByRole("button", { name: "Plugin manager", exact: true }).click();
    else await page.getByRole("button", { name: "Refresh plugins", exact: true }).click();
    await reading;
    await other.goto(bridge.url);
    await other.getByRole("button", { name: "Plugin manager", exact: true }).click();
    await expect(other.getByRole("switch", { name: "Enable Git", exact: true })).toBeChecked();
    const invalidated = page.waitForResponse(async response => response.url().endsWith("/api/plugins") && !(await response.json()).plugins.some((plugin: { id: string }) => plugin.id === "@pi-webapp/git"));
    await other.getByRole("switch", { name: "Enable Git", exact: true }).click();
    await expect(other.getByRole("switch", { name: "Enable Git", exact: true })).not.toBeChecked();
    await invalidated;
    release();
    await expect(page.getByRole("switch", { name: "Enable Git", exact: true })).not.toBeChecked();
  } finally { release(); await other.close(); await page.goto("about:blank"); await bridge.close(); await rm(cwd, { recursive: true, force: true }); }
});
