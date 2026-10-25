import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { HostedPluginIntegration } from "../../src/host/server/plugins/hosted/integration.ts";
import { startBridge, type Bridge } from "../../src/host/server/transport/bridge.ts";
import { NodeTelemetry } from "../../src/platform/telemetry/telemetry.ts";
import { terminalHost } from "../helpers/terminal-host.ts";
import { integrationFixture, hostedId as id, integrity } from "../helpers/hosted-integration-fixture.ts";

test("no strategy selector; independent check and fixed software-linked synchronization preserve disablement", async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), "hosted-policy-browser-")), old = integrationFixture(), next = integrationFixture("0.2.0");
  const workerEntry = join(root, "worker.mjs"); let bridge: Bridge | undefined, downloads = 0;
  await build({ entryPoints: [new URL("../../src/host/server/plugins/hosted/worker-entry.ts", import.meta.url).pathname], outfile: workerEntry, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  const integration = new HostedPluginIntegration({ root: join(root, "hosted"), workerEntry, hostVersion: "0.1.29", ownerId: "local", resolveSession: () => null,
    changed: () => bridge?.publish({ type: "hosted_plugins_changed" }),
    fetch: (async url => { if (String(url).endsWith(".tgz")) { downloads++; return new Response(new Uint8Array(next.bytes)); } return Response.json({ versions: { "0.1.0": old.release, "0.2.0": next.release } }); }) as typeof fetch });
  try {
    await integration.start();
    await integration.manager.installer.installArchive(id, old.bytes, integrity(old.bytes), "0.1.0");
    const { host } = terminalHost(root); host.hosted = integration.handlers;
    bridge = await startBridge(host, new URL("../../web/dist", import.meta.url).pathname, new NodeTelemetry({ env: { PI_WEB_SENTRY_ENABLED: "false" }, monitor: false }), { pluginSettingsFile: join(root, "plugins.json") });
    await page.addInitScript(() => localStorage.setItem("pi-web-locale", "en"));
    await page.goto(bridge.url);
    await page.getByRole("button", { name: "Plugins", exact: true }).click();
    const panel = page.locator("[data-hosted-management]"); await expect(panel).toBeVisible();
    await expect(panel).toContainText("Installed plugins update with the app");
    await expect(panel.getByRole("combobox")).toHaveCount(0);
    await panel.getByRole("button", { name: "Check updates", exact: true }).click();
    await expect(panel).toContainText("Available release: 0.2.0"); expect(downloads).toBe(0);
    // Drive the real startup reconciliation seam, not a mocked browser catalog response.
    expect(await integration.manager.reconcileHostUpgrade()).toBe(true); expect(downloads).toBe(1);
    await panel.getByRole("button", { name: "Reload status", exact: true }).click();
    await expect(panel).toContainText("Installed · Disabled 0.2.0"); await expect(panel.getByRole("combobox")).toHaveCount(0);
  } finally { await bridge?.close(); await integration.shutdown(); await rm(root, { recursive: true, force: true }); }
});
