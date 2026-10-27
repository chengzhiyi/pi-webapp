import { test, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { HostedPluginIntegration } from "../../src/host/server/plugins/hosted/integration.ts";
import { HostedStateBroker } from "../../src/host/server/plugins/hosted/state-broker.ts";
import { startBridge, type Bridge } from "../../src/host/server/transport/bridge.ts";
import { NodeTelemetry } from "../../src/platform/telemetry/telemetry.ts";
import { terminalHost } from "../helpers/terminal-host.ts";
import { hostedId as id, integrationFixture, integrity } from "../helpers/hosted-integration-fixture.ts";

for (const locale of ["zh", "en"] as const) test(`retained runtime lock is unavailable, not a healthy enabled editor (${locale})`, async ({ page }, info) => {
  const root = await mkdtemp(join(tmpdir(), "ori54-owned-"));
  let bridge: Bridge | undefined;
  const integration = new HostedPluginIntegration({ root, workerEntry: "unused", hostVersion: "0.1.29", ownerId: "test", resolveSession: () => null });
  const fixture = integrationFixture(), broker = new HostedStateBroker(join(root, "data"), id);
  try {
    await integration.manager.installer.installArchive(id, fixture.bytes, integrity(fixture.bytes), "0.1.0");
    await broker.activate(0, { version: "0.1.0", stateRef: randomUUID(), schema: 1, enabled: true });
    const lock = join(broker.root, "runtime.lock"), bytes = JSON.stringify({ pid: 2147483647, ownerId: "retained-owner" });
    await writeFile(lock, bytes);
    const before = await broker.active();
    await writeFile(join(root, "host-version.json"), JSON.stringify({ version: "0.1.29" }));
    await integration.start();
    const { host } = terminalHost(root); host.hosted = integration.handlers;
    bridge = await startBridge(host, new URL("../../web/dist", import.meta.url).pathname, new NodeTelemetry({ env: { PI_WEB_SENTRY_ENABLED: "false" }, monitor: false }), { pluginSettingsFile: join(root, "plugins.json") });
    await page.addInitScript(locale => localStorage.setItem("pi-web-locale", locale), locale);
    await page.goto(bridge.url);
    await page.getByRole("button", { name: locale === "zh" ? "插件" : "Plugins", exact: true }).click();
    const panel = page.locator("[data-hosted-management]");
    await expect(panel).toContainText(locale === "zh" ? "运行时不可用" : "Runtime unavailable");
    await panel.getByRole("button", { name: locale === "zh" ? "Excalidraw（官方）" : "Excalidraw (Official)", exact: true }).click();
    await expect(panel.getByRole("alert")).toContainText(locale === "zh" ? "重新安装不会清除此锁" : "reinstalling does not clear the lock");
    await panel.getByRole("button", { name: locale === "zh" ? "卸载" : "Uninstall", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: locale === "zh" ? "继续" : "Continue", exact: true }).click();
    await expect(panel.getByRole("status")).toHaveCount(0);
    await expect(panel.getByRole("alert")).toContainText(locale === "zh" ? "当前无法打开或卸载" : "including opening and uninstalling");
    await panel.getByText(locale === "zh" ? "诊断信息" : "Diagnostics", { exact: true }).click();
    await expect(panel.getByRole("alert")).toContainText("runtime_owned");
    assert.equal(await readFile(lock, "utf8"), bytes);
    assert.deepEqual(await broker.active(), before);
    await page.screenshot({ path: info.outputPath(`runtime-owned-${locale}.png`), fullPage: true });
  } finally { await page.close(); await bridge?.close(); await integration.shutdown(); await rm(root, { recursive: true, force: true }); }
});
