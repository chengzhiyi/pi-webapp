import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { randomUUID } from "node:crypto";
import { HostedPluginIntegration } from "../src/host/server/plugins/hosted/integration.ts";
import { hostedApi } from "../src/host/server/plugins/hosted/routes.ts";
import { hostedId as id, integrationFixture, integrity } from "./helpers/hosted-integration-fixture.ts";

for (const mode of ["cancel", "interrupt", "ENOSPC"] as const) test(`management download ${mode}: old immutable bytes remain loadable; candidate never admitted`, async t => {
  const root = await mkdtemp(join(tmpdir(), "ori40-download-"));
  const workerEntry = join(root, "worker.mjs");
  await build({ entryPoints: [new URL("../src/host/server/plugins/hosted/worker-entry.ts", import.meta.url).pathname], outfile: workerEntry, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  const first = integrationFixture(), next = integrationFixture("0.2.0");
  let stream!: ReadableStreamDefaultController<Uint8Array>, started!: () => void, cancelled = false;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const integration = new HostedPluginIntegration({ root, workerEntry, hostVersion: "0.1.29", ownerId: "fault-test", resolveSession: () => null,
    fetch: (async url => {
      if (!String(url).endsWith(".tgz")) return Response.json({ versions: { "0.2.0": next.release } });
      if (mode === "ENOSPC") return new Response(new Uint8Array(next.bytes));
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; controller.enqueue(new Uint8Array(next.bytes.subarray(0, 32))); started(); }, cancel() { cancelled = true; } }));
    }) as typeof fetch });
  t.after(async () => { await integration.shutdown(); await rm(root, { recursive: true, force: true }); });
  await integration.start();
  const installer = integration.manager.installer;
  const old = await installer.installArchive(id, first.bytes, integrity(first.bytes), "0.1.0");
  await integration.manage({ pluginId: id, operation: "enable" });
  const generation = (await integration.inventory()).plugins[0]!.generation!;
  const oldManifest = await readFile(join(old.root, "package.json"));
  let writes = 0;
  if (mode === "ENOSPC") {
    // Precise file-layer injection, not a claim that the physical disk is full.
    const original = fs.writeFile;
    t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
      if (String(args[0]).includes("/staging/stage-") && ++writes === 2) throw Object.assign(new Error("injected ENOSPC staging write"), { code: "ENOSPC" });
      return original(...args);
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  }
  const downloadId = randomUUID();
  const result = hostedApi(integration.handlers, "/api/hosted-plugins/manage", { pluginId: id, operation: "update", downloadId });
  const rejected = assert.rejects(result, mode === "cancel" ? /cancel/i : mode === "interrupt" ? /connection reset/ : /ENOSPC/);
  if (mode !== "ENOSPC") {
    await ready;
    await assert.rejects(hostedApi(integration.handlers, "/api/hosted-plugins/manage", { pluginId: id, operation: "cancel-download", downloadId: randomUUID() }), /no longer pending/);
    if (mode === "cancel") await hostedApi(integration.handlers, "/api/hosted-plugins/manage", { pluginId: id, operation: "cancel-download", downloadId });
    else stream.error(new Error("connection reset during archive"));
  }
  await rejected;
  if (mode === "cancel") assert.equal(cancelled, true);
  if (mode === "ENOSPC") assert.equal(writes, 2);
  assert.equal((await installer.load(id, "0.1.0")).digest, old.digest);
  assert.deepEqual(await readFile(join(old.root, "package.json")), oldManifest);
  await assert.rejects(installer.load(id, "0.2.0"), /not installed/);
  assert.equal((await installer.inventory()).versions[id]!.length, 1);
  assert.deepEqual(await readdir(join(installer.root, "staging")), []);
  assert.equal((await integration.inventory()).plugins[0]!.updateDiagnostic?.status, "failed");
  assert.equal((await integration.inventory()).plugins[0]!.enabled, true);
  assert.equal((await integration.inventory()).plugins[0]!.generation, generation);
  const reply = await integration.manager.invoke(id, generation, { requestId: randomUUID(), scope: { cwd: root, sessionId: "session", workspaceId: "workspace" }, kind: "action", action: "reference", input: {} }) as { version: string };
  assert.equal(reply.version, "0.1.0");
});
