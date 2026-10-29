import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { HostedPluginIntegration } from "../../src/host/server/plugins/hosted/integration.ts";
import { startBridge, type Bridge } from "../../src/host/server/transport/bridge.ts";
import { NodeTelemetry } from "../../src/platform/telemetry/telemetry.ts";
import { terminalHost } from "../helpers/terminal-host.ts";
import { integrationFixture } from "../helpers/hosted-integration-fixture.ts";

for (const width of [390, 768, 1440]) test(`official rows keep actions independent from accessible detail navigation at ${width}px`, async ({ page }, info) => {
  test.setTimeout(45_000);
  const root = await mkdtemp(join(tmpdir(), "ori51-navigation-")), workerEntry = join(root, "worker.mjs");
  await build({ entryPoints: [new URL("../../src/host/server/plugins/hosted/worker-entry.ts", import.meta.url).pathname], outfile: workerEntry, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  let release = integrationFixture(), bridge: Bridge | undefined;
  const integration = new HostedPluginIntegration({ root: join(root, "hosted"), workerEntry, hostVersion: "0.1.29", ownerId: "local", resolveSession: () => null,
    fetch: (async url => String(url).endsWith(".tgz") ? new Response(new Uint8Array(release.bytes)) : Response.json({ versions: { [release.release.version]: release.release } })) as typeof fetch });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  let releaseEnable: (() => void) | undefined;
  try {
    await integration.start();
    const { host } = terminalHost(root); host.hosted = integration.handlers;
    bridge = await startBridge(host, new URL("../../web/dist", import.meta.url).pathname, new NodeTelemetry({ env: { PI_WEB_SENTRY_ENABLED: "false" }, monitor: false }), { pluginSettingsFile: join(root, "plugins.json") });
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(() => { localStorage.setItem("pi-web-locale", "en"); localStorage.setItem("pi-web-theme", "light"); });
    let offline = true;
    await page.route("**/api/hosted-plugins", route => offline ? route.fulfill({ status: 503, json: { error: "fixture catalog offline" } }) : route.continue());
    await page.goto(bridge.url); await page.getByRole("button", { name: "Plugins", exact: true }).click();
    const panel = page.locator("[data-hosted-management]"), toggle = panel.getByRole("switch", { name: "Enable Excalidraw", exact: true });
    const refresh = page.getByRole("button", { name: "Refresh plugins", exact: true });
    await expect(panel).toContainText("Installation unknown"); await expect(toggle).toBeDisabled();
    await expect(panel.getByRole("button", { name: "Download", exact: true })).toBeDisabled();
    offline = false; await refresh.click();
    await expect(panel).toContainText("Not installed · Disabled"); await expect(panel.getByRole("alert")).toHaveCount(0);
    await panel.getByRole("button", { name: "Download", exact: true }).click();
    await expect(panel).toContainText("Installed · Disabled 0.1.0"); await expect(toggle).toBeEnabled();
    await expect(page.getByRole("heading", { name: "Plugins", exact: true })).toBeVisible();
    let failEnable = true, enableCount = 0;
    const enableGate = new Promise<void>(resolve => { releaseEnable = resolve; });
    await page.route("**/api/hosted-plugins/manage", async route => {
      if (route.request().postDataJSON().operation === "enable") {
        enableCount++;
        if (failEnable) return route.fulfill({ status: 409, json: { error: { code: "view_barrier", message: "fixture save barrier rejected" } } });
        await enableGate;
      }
      await route.continue();
    });
    await toggle.click();
    await expect(panel.getByRole("alert")).toContainText("Operation did not finish");
    await expect(toggle).toBeEnabled(); await expect(toggle).not.toBeChecked(); expect(enableCount).toBe(1);
    failEnable = false; await toggle.click();
    await expect.poll(() => enableCount).toBe(2);
    await expect(toggle).toBeDisabled(); await expect(toggle).not.toBeChecked();
    await expect(refresh).toBeDisabled();
    await expect(page.getByRole("switch", { name: "Enable Git", exact: true })).toBeDisabled();
    await expect(panel.getByRole("button", { name: "Update", exact: true })).toBeDisabled();
    releaseEnable?.();
    await expect(toggle).toBeChecked(); await expect(toggle).toBeEnabled();
    await expect(panel.getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Plugins", exact: true })).toBeVisible();
    // Keyboard navigation opens a real detail page, not an expanding row.
    const open = panel.getByRole("button", { name: "Excalidraw (Official)", exact: true });
    await open.focus(); await page.keyboard.press("Enter");
    await expect(page.locator("[data-hosted-detail]")).toBeVisible();
    await expect(page.getByRole("searchbox", { name: "Search plugins", exact: true })).toHaveCount(0);
    await expect(page.locator("[data-plugin-package]")).toHaveCount(0);
    await page.getByRole("button", { name: "‹ Plugins", exact: true }).click();
    // Cancelling the destructive switch leaves authoritative state untouched.
    await toggle.click();
    const dialog = page.getByRole("dialog", { name: "Disable Excalidraw?", exact: true });
    await expect(dialog).toContainText("saving successfully");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click(); await expect(toggle).toBeChecked();
    await toggle.click(); await dialog.getByRole("button", { name: "Disable", exact: true }).click();
    await expect(toggle).not.toBeChecked(); await expect(toggle).toBeEnabled();
    // Updating from the row cannot accidentally enter details or enable a disabled plugin.
    release = integrationFixture("0.2.0");
    await panel.getByRole("button", { name: "Update", exact: true }).click();
    await expect(panel).toContainText("Installed · Disabled 0.2.0"); await expect(toggle).not.toBeChecked();
    await expect(page.getByRole("heading", { name: "Plugins", exact: true })).toBeVisible();
    await refresh.click(); await expect(toggle).toBeEnabled(); await expect(toggle).not.toBeChecked();
    await page.screenshot({ path: info.outputPath(`official-list-${width}.png`), fullPage: true });
    // The description participates in whole-row pointer navigation too.
    const description = await panel.getByText("Draw and edit hand-drawn diagrams, and save them to your workspace.", { exact: true }).boundingBox();
    expect(description).not.toBeNull();
    // The title button's stretched hit target intentionally overlays the description.
    await page.mouse.click(description!.x + description!.width / 2, description!.y + description!.height / 2);
    await expect(page.locator("[data-hosted-detail]")).toBeVisible();
    await expect(toggle).not.toBeChecked();
    await page.screenshot({ path: info.outputPath(`official-detail-${width}.png`), fullPage: true });
    await panel.getByRole("button", { name: "Uninstall", exact: true }).click();
    await page.getByRole("dialog", { name: "Uninstall Excalidraw?", exact: true }).getByRole("button", { name: "Uninstall", exact: true }).click();
    await expect(panel).toContainText("Not installed · Disabled"); await expect(toggle).toBeDisabled();
    await expect(panel.getByRole("button", { name: "Download", exact: true })).toBeEnabled();
    expect(await page.locator("[data-plugin-panel]").evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    expect(errors).toEqual([]);
  } finally { releaseEnable?.(); await integration.shutdown(); await page.close(); await bridge?.close(); await rm(root, { recursive: true, force: true }); }
});
