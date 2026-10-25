import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { HostedPluginIntegration } from "../src/host/server/plugins/hosted/integration.ts";
import { HostedPluginManager } from "../src/host/server/plugins/hosted/manager.ts";
import { hostUpdateDecision } from "../src/host/server/plugins/hosted/official-catalog.ts";
import { hostedId as id, integrationFixture, integrity } from "./helpers/hosted-integration-fixture.ts";

async function fixture(_t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "hosted-linked-"));
  const workerEntry = join(root, "worker.mjs");
  await build({ entryPoints: [new URL("../src/host/server/plugins/hosted/worker-entry.ts", import.meta.url).pathname], outfile: workerEntry, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  return { root, workerEntry };
}
const hooks = () => ({ canSwitch: () => true, freeze: async () => {}, resume: async () => {}, committed: async () => {} });

test("host-linked default updates live runtime; failed download preserves old generation and retries; never downgrades", async t => {
  const options = await fixture(t), old = integrationFixture(), next = integrationFixture("0.2.0");
  let fail = true, olderOnly = false, downloads = 0;
  const manager = new HostedPluginManager({ ...options, hostVersion: "0.1.29", hooks, fetch: (async url => {
    if (String(url).endsWith(".tgz")) { downloads++; if (fail) throw new Error("injected archive interruption"); return new Response(new Uint8Array(next.bytes)); }
    return Response.json({ versions: olderOnly ? { "0.1.0": old.release } : { "0.1.0": old.release, "0.2.0": next.release } });
  }) as typeof fetch });
  t.after(async () => { await manager.shutdown(); await rm(options.root, { recursive: true, force: true }); });
  await manager.installer.installArchive(id, old.bytes, integrity(old.bytes), "0.1.0");
  await manager.manage(id, "enable"); const generation = manager.tools[0]!.generation;
  assert.equal(await manager.reconcileHostUpgrade(), false);
  assert.equal(manager.tools[0]!.generation, generation);
  assert.equal((await manager.inventory()).plugins[0]!.activeVersion, "0.1.0");
  fail = false; assert.equal(await manager.reconcileHostUpgrade(), true);
  assert.equal((await manager.inventory()).plugins[0]!.activeVersion, "0.2.0");
  assert.equal(manager.tools[0]!.generation, generation + 1);
  olderOnly = true; assert.equal(await manager.reconcileHostUpgrade(), false);
  assert.equal((await manager.inventory()).plugins[0]!.activeVersion, "0.2.0");
  assert.equal(downloads, 2);
});

test("host-linked pending waits for editors without undo reset, and does not claim completed synchronization", async t => {
  const options = await fixture(t), old = integrationFixture(), next = integrationFixture("0.2.0"); let canSwitch = true;
  const manager = new HostedPluginManager({ ...options, hostVersion: "0.1.29", hooks: () => ({ ...hooks(), canSwitch: () => canSwitch }), fetch: (async url => String(url).endsWith(".tgz") ? new Response(new Uint8Array(next.bytes)) : Response.json({ versions: { "0.2.0": next.release } })) as typeof fetch });
  t.after(async () => { await manager.shutdown(); await rm(options.root, { recursive: true, force: true }); });
  await manager.installer.installArchive(id, old.bytes, integrity(old.bytes), "0.1.0"); await manager.manage(id, "enable");
  canSwitch = false; assert.equal(await manager.reconcileHostUpgrade(), false);
  let card = (await manager.inventory()).plugins[0]!;
  assert.equal(card.pendingVersion, "0.2.0"); assert.equal(card.activeVersion, "0.1.0");
  canSwitch = true; await manager.manage(id, "retry");
  card = (await manager.inventory()).plugins[0]!; assert.equal(card.activeVersion, "0.2.0"); assert.equal(card.pendingVersion, null);
});

test("future-host gate refuses incompatible pinned/disabled pairs and missing worker, without registry access", async t => {
  const options = await fixture(t), pkg = integrationFixture(); let calls = 0;
  const integration = new HostedPluginIntegration({ ...options, hostVersion: "0.1.29", ownerId: "local", resolveSession: () => null, fetch: (async () => { calls++; throw new Error("offline"); }) as typeof fetch });
  t.after(async () => { await integration.shutdown(); await rm(options.root, { recursive: true, force: true }); });
  await integration.start();
  const candidate = join(options.root, "candidate"); await mkdir(candidate);
  await integration.validateHostUpdate("0.2.0", candidate); // absent does not require editor support
  await integration.manager.installer.installArchive(id, pkg.bytes, integrity(pkg.bytes), "0.1.0");
  await integration.manager.setPolicy(id, { updatePolicy: "pinned", pinnedVersion: "0.1.0" });
  await assert.rejects(integration.validateHostUpdate("1.0.0", candidate), /Host update blocked/);
  await assert.rejects(integration.validateHostUpdate("0.2.0", candidate), /no hosted worker/);
  assert.equal(calls, 0); assert.equal((await integration.inventory()).plugins[0]!.enabled, false);
});

test("incompatible pinned runtime never starts after host change and keeps required action visible", async t => {
  const options = await fixture(t), pkg = integrationFixture();
  const seed = new HostedPluginManager({ ...options, hostVersion: "0.1.29", hooks });
  await seed.installer.installArchive(id, pkg.bytes, integrity(pkg.bytes), "0.1.0");
  await seed.manage(id, "enable"); await seed.setPolicy(id, { updatePolicy: "pinned", pinnedVersion: "0.1.0" }); await seed.shutdown();
  let calls = 0;
  const integration = new HostedPluginIntegration({ ...options, hostVersion: "1.0.0", ownerId: "local", resolveSession: () => null,
    fetch: (async () => { calls++; throw new Error("offline registry"); }) as typeof fetch });
  t.after(async () => { await integration.shutdown(); await rm(options.root, { recursive: true, force: true }); });
  await integration.start();
  const card = (await integration.inventory()).plugins[0]!;
  assert.equal(integration.manager.tools.length, 0); assert.equal(card.documentUrl, undefined);
  assert.equal(card.updatePolicy, "notify"); assert.equal(card.enabled, true); // intent, not a running runtime
  assert.match(card.error!, /offline registry/); assert.equal(card.updateDiagnostic!.status, "failed"); assert.equal(calls, 1);
  await assert.rejects(readFile(join(options.root, "host-version.json")), { code: "ENOENT" });
});

test("notification is independent of host-linked default", () => {
  const input = { installed: true, enabled: true, policy: "notify" as const, currentCompatible: true, currentVersion: "0.1.0", recommendedVersion: "0.2.0", networkAvailable: true };
  assert.equal(hostUpdateDecision(input).action, "update");
  assert.equal(hostUpdateDecision({ ...input, trigger: "independent" }).action, "notify");
});

test("exact external 0.1.0 archive remains compatible across stable host startup and offline linked retry", { skip: !process.env.HOSTED_EXCALIDRAW_TGZ }, async t => {
  const options = await fixture(t), bytes = await readFile(process.env.HOSTED_EXCALIDRAW_TGZ!);
  // Default pins this integrated source's independently built archive; other exact
  // builds must supply their recorded digest rather than bypass integrity checks.
  assert.equal(createHash("sha256").update(bytes).digest("hex"), process.env.HOSTED_EXCALIDRAW_SHA256 ?? "9a9b92631e5a534c1fda83e7bbeb5743d1de20be91bda39f6984a01bb1e71a68");
  let calls = 0, online = false, actualManifest: unknown;
  const opts = { ...options, hostVersion: "0.1.29", ownerId: "local", resolveSession: () => null, fetch: (async url => {
    assert.equal(String(url).endsWith(".tgz"), false); calls++;
    if (!online) throw new Error("offline registry");
    return Response.json({ versions: { "0.1.0": { name: id, version: "0.1.0", piWebapp: actualManifest,
      dist: { tarball: "https://registry.npmjs.org/local-exact-0.1.0.tgz", integrity: integrity(bytes) } } } });
  }) as typeof fetch };
  let integration = new HostedPluginIntegration(opts);
  await integration.start();
  const pkg = await integration.manager.installer.installArchive(id, bytes, integrity(bytes), "0.1.0");
  actualManifest = pkg.manifest;
  assert.equal(pkg.manifest.hostRange.includes("0.1."), true);
  await integration.manager.manage(id, "enable"); await integration.shutdown();
  // Actual archive metadata is authoritative: do not manufacture an unpublished successor.
  integration = new HostedPluginIntegration({ ...opts, hostVersion: "0.1.30" }); t.after(async () => { await integration.shutdown(); await rm(options.root, { recursive: true, force: true }); });
  await integration.start(); await integration.start();
  assert.equal(calls, 1); const card = (await integration.inventory()).plugins[0]!;
  assert.equal(card.version, "0.1.0"); assert.equal(card.enabled, true);
  assert.equal(integration.manager.tools.length, 1); assert.equal(card.updateDiagnostic!.status, "failed");
  assert.equal(JSON.parse(await readFile(join(options.root, "host-version.json"), "utf8")).version, "0.1.29");
  await integration.shutdown(); online = true;
  integration = new HostedPluginIntegration({ ...opts, hostVersion: "0.1.30" }); await integration.start();
  assert.equal(calls, 2); assert.equal((await integration.inventory()).plugins[0]!.updateDiagnostic!.status, "up-to-date");
  assert.equal(JSON.parse(await readFile(join(options.root, "host-version.json"), "utf8")).version, "0.1.30");
  await integration.shutdown();
  integration = new HostedPluginIntegration({ ...opts, hostVersion: "0.1.30" }); await integration.start();
  assert.equal(calls, 2); assert.equal(integration.manager.tools.length, 1);
});
