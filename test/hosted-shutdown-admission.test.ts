import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { HostedPluginIntegration } from "../src/host/server/plugins/hosted/integration.ts";
import { hostedId as id, integrationFixture, integrity } from "./helpers/hosted-integration-fixture.ts";
const latch = () => { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { resolve, promise }; };

test("shutdown does not reclassify an already preparing enable as a terminal freeze", { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "hosted-shutdown-admission-")), workerEntry = join(root, "worker.mjs");
  await build({ entryPoints: [new URL("../src/host/server/plugins/hosted/worker-entry.ts", import.meta.url).pathname], outfile: workerEntry, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  const integration = new HostedPluginIntegration({ root, hostVersion: "0.1.29", workerEntry, ownerId: "test", resolveSession: () => null });
  const entered = latch(), release = latch();
  let stopped = false;
  try {
    await integration.start();
    const fixture = integrationFixture(); await integration.manager.installer.installArchive(id, fixture.bytes, integrity(fixture.bytes), "0.1.0");
    const load = integration.manager.installer.load.bind(integration.manager.installer);
    integration.manager.installer.load = async (...args) => { entered.resolve(); await release.promise; return load(...args); };
    const enabling = integration.manage({ pluginId: id, operation: "enable" });
    const outcome = enabling.then(() => "enabled", error => String(error));
    await entered.promise;
    const shutdown = integration.shutdown();
    release.resolve();
    const result = await outcome;
    await shutdown; stopped = true;
    assert.match(result, /Host is shutting down/, "preparing operation must stop before activation, not retain a terminal freeze");
    assert.equal((await integration.inventory()).plugins[0]!.enabled, false);
  } finally { release.resolve(); if (!stopped) await integration.shutdown(); await rm(root, { recursive: true, force: true }); }
});
