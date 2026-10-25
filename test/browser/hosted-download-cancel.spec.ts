import { test, expect } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostedPluginIntegration } from "../../src/host/server/plugins/hosted/integration.ts";
import { startBridge, type Bridge } from "../../src/host/server/transport/bridge.ts";
import { NodeTelemetry } from "../../src/platform/telemetry/telemetry.ts";
import { terminalHost } from "../helpers/terminal-host.ts";
import { hostedId as id, integrationFixture, integrity } from "../helpers/hosted-integration-fixture.ts";

for (const fault of ["cancel", "interrupt"] as const) test(`actual management UI/HTTP: ${fault} partial update retains old installed bytes`, async ({ page }) => {
  test.setTimeout(30_000);
  const root = await mkdtemp(join(tmpdir(), "ori40-ui-"));
  const first = integrationFixture(), next = integrationFixture("0.2.0");
  let started = false, cancelled = false, stream!: ReadableStreamDefaultController<Uint8Array>, bridge: Bridge | undefined;
  const integration = new HostedPluginIntegration({ root, workerEntry: "unused", hostVersion: "0.1.29", ownerId: "local-ui-test", resolveSession: () => null,
    fetch: (async url => String(url).endsWith(".tgz") ? new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; controller.enqueue(new Uint8Array(next.bytes.subarray(0, 32))); started = true; }, cancel() { cancelled = true; } })) : Response.json({ versions: { "0.2.0": next.release } })) as typeof fetch });
  try {
    await integration.start();
    const installer = integration.manager.installer, old = await installer.installArchive(id, first.bytes, integrity(first.bytes), "0.1.0");
    const original = await readFile(join(old.root, "package.json"));
    const { host } = terminalHost(root); host.hosted = integration.handlers;
    bridge = await startBridge(host, new URL("../../web/dist", import.meta.url).pathname, new NodeTelemetry({ env: { PI_WEB_SENTRY_ENABLED: "false" }, monitor: false }), { pluginSettingsFile: join(root, "plugins.json") });
    await page.addInitScript(() => localStorage.setItem("pi-web-locale", "en"));
    await page.goto(bridge.url); await page.getByRole("button", { name: "Plugins", exact: true }).click();
    const manager = page.locator("[data-hosted-management]");
    await expect(manager).toContainText("Installed · Disabled");
    await manager.getByRole("button", { name: "Update (wait for editors)", exact: true }).click();
    await expect.poll(() => started).toBe(true);
    if (fault === "cancel") {
      await manager.getByRole("button", { name: "Cancel download (no rollback after commit)", exact: true }).click();
      await expect.poll(() => cancelled).toBe(true);
    } else stream.error(new Error("connection reset during archive"));
    await expect(manager.getByRole("alert").first()).toContainText(fault === "cancel" ? /cancel/i : /connection reset/);
    await expect(manager.getByRole("button", { name: "Reload status", exact: true })).toBeEnabled();
    await manager.getByRole("button", { name: "Reload status", exact: true }).click();
    await expect(manager).toContainText("Installed · Disabled");
    await expect(manager).toContainText("0.1.0");
    expect((await installer.load(id, "0.1.0")).digest).toBe(old.digest);
    expect(await readFile(join(old.root, "package.json"))).toEqual(original);
    await expect(installer.load(id, "0.2.0")).rejects.toThrow(/not installed/);
  } finally { await integration.shutdown(); await page.close(); await bridge?.close(); await rm(root, { recursive: true, force: true }); }
});
