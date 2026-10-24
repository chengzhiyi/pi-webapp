import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, symlink, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import { HostedPluginManager } from "../src/host/server/plugins/hosted/manager.ts";
import { HostedPluginIntegration } from "../src/host/server/plugins/hosted/integration.ts";
import { HostedStateBroker } from "../src/host/server/plugins/hosted/state-broker.ts";
import { atomicJson } from "../src/host/server/plugins/hosted/storage.ts";
import { inspectStoppedStorage, recoverStoppedLocks, recoverStoppedFork, STOPPED_CONFIRMATION } from "../src/host/server/plugins/hosted/stopped-recovery.ts";
import { hostedApi } from "../src/host/server/plugins/hosted/routes.ts";
import { hostedId as id, integrationFixture, integrity } from "./helpers/hosted-integration-fixture.ts";

const hooks = () => ({ canSwitch: () => true, freeze: async () => {}, resume: async () => {}, committed: async () => {} });
async function temporary(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "hosted-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
async function worker(root: string) {
  const outfile = join(root, "worker.mjs");
  await build({ entryPoints: [new URL("../src/host/server/plugins/hosted/worker-entry.ts", import.meta.url).pathname], outfile, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  return outfile;
}

test("independent notify never downloads; default host-linked preserves disabled/absent and pin intent", async t => {
  const root = await temporary(t), first = integrationFixture(), next = integrationFixture("0.2.0");
  let registry = 0, downloads = 0;
  const options = { root, hostVersion: "0.1.29", workerEntry: "unused", hooks, fetch: (async url => {
    if (String(url).endsWith(".tgz")) { downloads++; return new Response(new Uint8Array(next.bytes)); }
    registry++; return Response.json({ versions: { "0.1.0": first.release, "0.2.0": next.release } });
  }) as typeof fetch };
  let manager = new HostedPluginManager(options);
  assert.equal(await manager.reconcileHostUpgrade(), true); assert.equal(registry, 0);
  await manager.installer.installArchive(id, first.bytes, integrity(first.bytes), "0.1.0");
  await manager.manage(id, "check"); assert.equal(registry, 1); assert.equal(downloads, 0);
  assert.equal((await manager.inventory()).plugins[0]!.availableVersion, "0.2.0");
  manager = new HostedPluginManager(options);
  assert.equal((await manager.inventory()).plugins[0]!.updateDiagnostic?.status, "available");
  await assert.rejects(manager.setPolicy(id, { updatePolicy: "pinned" }), /Invalid/);
  await manager.setPolicy(id, { updatePolicy: "pinned", pinnedVersion: "0.1.0" });
  await manager.reconcileHostUpgrade(); assert.equal(registry, 1);
  await assert.rejects(manager.manage(id, "enable", "0.2.0"), /pin/i);
  assert.match((await manager.inventory()).plugins[0]!.updateDiagnostic!.message, /Pinned version retained/);
  await manager.setPolicy(id, { updatePolicy: "notify" });
  assert.equal(await manager.reconcileHostUpgrade(), true); assert.equal(downloads, 1);
  const card = (await manager.inventory()).plugins[0]!;
  assert.equal(card.installed, true); assert.equal(card.enabled, false); assert.equal(card.activeVersion, null);
  await manager.manage(id, "check");
  assert.equal((await manager.inventory()).plugins[0]!.availableVersion, null);
  assert.match((await manager.inventory()).plugins[0]!.updateDiagnostic!.message, /No newer compatible/);
});

test("failed host reconciliation does not mark success; next startup retries then successful version runs once", async t => {
  const root = await temporary(t), fixture = integrationFixture(); let online = false, calls = 0;
  const options = { root, hostVersion: "0.1.29", workerEntry: "unused", ownerId: "local", resolveSession: () => null,
    fetch: (async () => { calls++; if (!online) throw new Error("offline registry"); return Response.json({ versions: { "0.1.0": fixture.release } }); }) as typeof fetch };
  let integration = new HostedPluginIntegration(options);
  await integration.manager.installer.installArchive(id, fixture.bytes, integrity(fixture.bytes), "0.1.0");
  await integration.start(); await integration.start(); assert.equal(calls, 1);
  await assert.rejects(readFile(join(root, "host-version.json")), { code: "ENOENT" });
  assert.equal((await integration.inventory()).plugins[0]!.updateDiagnostic!.status, "failed");
  await integration.shutdown(); online = true;
  integration = new HostedPluginIntegration(options); await integration.start(); assert.equal(calls, 2);
  assert.equal(JSON.parse(await readFile(join(root, "host-version.json"), "utf8")).version, options.hostVersion);
  await integration.shutdown(); integration = new HostedPluginIntegration(options); await integration.start(); assert.equal(calls, 2);
  await integration.shutdown();
});

test("policy wire input rejects missing/invalid pins and strips arbitrary storage/scope arguments", async () => {
  let received: unknown;
  const host = { inventory: async () => ({}), manage: async (input: unknown) => { received = input; }, action: async () => null, views: async () => null, asset: async () => null };
  for (const input of [{ updatePolicy: "pinned" }, { updatePolicy: "steal" }, { updatePolicy: "pinned", version: "../bad" }])
    await assert.rejects(hostedApi(host, "/api/hosted-plugins/manage", { pluginId: id, operation: "policy", ...input }), /Invalid/);
  await hostedApi(host, "/api/hosted-plugins/manage", { pluginId: id, operation: "policy", updatePolicy: "notify", root: "/etc", cwd: "/etc" });
  assert.deepEqual(received, { pluginId: id, operation: "policy", updatePolicy: "notify" });
});

test("offline lock recovery requires stopped-owner attestation and exact byte fingerprint; never touches user data", async t => {
  const root = await temporary(t);
  await writeFile(join(root, "runtime.lock"), '{"pid":1,"ownerId":"not-proof"}');
  await writeFile(join(root, "transaction.lock"), '{"pid":1}');
  await writeFile(join(root, "active.json"), "latest pointer");
  const report = await inspectStoppedStorage(root);
  await assert.rejects(recoverStoppedLocks(root, report.fingerprint, "yes"), /confirmation/);
  await writeFile(join(root, "active.json"), "new accepted writes");
  await assert.rejects(recoverStoppedLocks(root, report.fingerprint, STOPPED_CONFIRMATION), /changed/);
  assert.ok((await readdir(root)).includes("runtime.lock"));
  const current = await inspectStoppedStorage(root);
  assert.deepEqual((await recoverStoppedLocks(root, current.fingerprint, STOPPED_CONFIRMATION)).recovered, ["runtime.lock", "transaction.lock"]);
  assert.equal(await readFile(join(root, "active.json"), "utf8"), "new accepted writes");
  assert.equal(await readFile(join(root, `recovered-${current.fingerprint}-runtime.lock.json`), "utf8"), '{"pid":1,"ownerId":"not-proof"}');
  await assert.rejects(recoverStoppedLocks(root, current.fingerprint, STOPPED_CONFIRMATION), /changed/);
  await symlink(join(root, "active.json"), join(root, "linked"));
  await assert.rejects(inspectStoppedStorage(root), /links/);
});

for (const stage of ["forked", "prepared", "committed", "cleaned"] as const) test(`SIGKILL at ${stage}: unique active pointer, stale generation fenced and user file hash preserved`, async t => {
  const root = await temporary(t), broker = new HostedStateBroker(join(root, "data"), id), cwd = join(root, "workspace");
  await mkdir(cwd);
  const before = await broker.activate(0, { version: "0.1.0", stateRef: randomUUID(), schema: 1, enabled: true });
  const request = { requestId: "old", generation: before.generation, kind: "action" as const, action: "read", input: {}, scope: { cwd, sessionId: "session", workspaceId: "workspace" } };
  await broker.call(request, "state.compareAndSwap", { key: "draft", expectedRevision: 0, schema: 1, value: "before" });
  const saved = await broker.call(request, "workspace.commit", { path: "场景.excalidraw", expectedHash: null, text: "original user file" });
  const script = join(root, "crash.mjs");
  await build({ stdin: { contents: `import {HostedStateBroker} from ${JSON.stringify(new URL("../src/host/server/plugins/hosted/state-broker.ts", import.meta.url).pathname)};
    const b=new HostedStateBroker(${JSON.stringify(join(root, "data"))},${JSON.stringify(id)},undefined,async stage=>{if(stage===${JSON.stringify(stage)})process.kill(process.pid,'SIGKILL')});
    const ref=await b.forkState(1); await b.activate(1,{version:'0.2.0',stateRef:ref,schema:1,enabled:true});`, resolveDir: process.cwd(), sourcefile: "crash.ts", loader: "ts" }, outfile: script, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  const exited = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const child = spawn(process.execPath, [script], { stdio: "pipe" });
    child.on("error", reject); child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  assert.equal(exited.signal, "SIGKILL");
  const report = await inspectStoppedStorage(broker.root);
  await recoverStoppedLocks(broker.root, report.fingerprint, STOPPED_CONFIRMATION);
  const recovered = await broker.recover();
  const committed = stage === "committed" || stage === "cleaned";
  assert.equal(recovered.active!.generation, committed ? 2 : 1);
  assert.equal(recovered.active!.version, committed ? "0.2.0" : "0.1.0");
  if (committed) {
    await assert.rejects(broker.call(request, "state.read", { key: "draft" }), /generation/);
    const latest = { ...request, generation: 2, requestId: "new" };
    await broker.call(latest, "state.compareAndSwap", { key: "draft", expectedRevision: 1, schema: 1, value: "postcommit new writes" });
    await broker.recover();
    assert.equal((await broker.call(latest, "state.read", { key: "draft" }) as { value: string }).value, "postcommit new writes");
  } else {
    assert.equal((await broker.call(request, "state.read", { key: "draft" }) as { value: string }).value, "before");
    await assert.rejects(broker.collect(async () => {}), /fork.json/); // retained unresolved reservation, never guessed away
    const inspected = await inspectStoppedStorage(broker.root);
    await recoverStoppedFork(join(root, "data"), id, inspected.fingerprint, STOPPED_CONFIRMATION);
    await broker.collect(async () => {});
    const next = await broker.forkState(1);
    await broker.activate(1, { version: "0.2.0", stateRef: next, schema: 1, enabled: true });
    assert.equal((await broker.call({ ...request, generation: 2 }, "state.read", { key: "draft" }) as { value: string }).value, "before");
  }
  assert.deepEqual(await broker.call({ ...request, generation: (await broker.active())!.generation }, "workspace.read", { path: "场景.excalidraw" }), { text: "original user file", ...(saved as { hash: string }) });
});

test("unknown journal/pointer relationship refuses recovery instead of discarding evidence", async t => {
  const root = await temporary(t), broker = new HostedStateBroker(root, id);
  const before = await broker.activate(0, { version: "0.1.0", stateRef: randomUUID(), schema: 1, enabled: true });
  await atomicJson(join(broker.root, "transition.json"), { version: 1, before: { ...before, operationId: "unrelated" }, next: { ...before, generation: 2, operationId: "other" } });
  await assert.rejects(broker.recover(), /does not match/);
  assert.deepEqual(await broker.active(), before); assert.ok(await readFile(join(broker.root, "transition.json")));
});

test("cross-schema replacement after newer accepted writes remains fail-closed without rollback", async t => {
  const root = await temporary(t), manager = new HostedPluginManager({ root, hostVersion: "0.1.29", workerEntry: await worker(root), hooks });
  t.after(() => manager.shutdown());
  const fixture = integrationFixture(); await manager.installer.installArchive(id, fixture.bytes, integrity(fixture.bytes), "0.1.0");
  await manager.manage(id, "enable");
  const broker = new HostedStateBroker(join(root, "data"), id), active = (await broker.active())!;
  const request = { requestId: "new-write", generation: active.generation, kind: "action" as const, action: "read", input: {}, scope: { cwd: root, sessionId: "session", workspaceId: "workspace" } };
  await broker.call(request, "state.compareAndSwap", { key: "draft", expectedRevision: 0, schema: 1, value: "latest" });
  // Verified schema-2 candidate metadata is injected at the supervisor boundary, not a corrupt installed archive.
  const { HostedPluginSupervisor } = await import("../src/host/server/plugins/hosted/supervisor.ts");
  await manager.shutdown();
  const supervisor = new HostedPluginSupervisor(broker, await worker(root));
  const pkg = await manager.installer.load(id, "0.1.0");
  await assert.rejects(supervisor.replace({ ...pkg, manifest: { ...pkg.manifest, dataSchemaVersion: 2, supportedDataSchemas: [2] } }), /Cross-schema/);
  assert.deepEqual(await broker.active(), active);
  assert.equal((await broker.call(request, "state.read", { key: "draft" }) as { value: string }).value, "latest");
  await supervisor.shutdown();
});

test("candidate SIGKILL during health preserves old worker, active pointer, state and workspace hash", async t => {
  const root = await mkdtemp(join(tmpdir(), "hosted-health-crash-")), entry = await worker(root);
  const manager = new HostedPluginManager({ root, hostVersion: "0.1.29", workerEntry: entry, hooks });
  const fixture = integrationFixture(); await manager.installer.installArchive(id, fixture.bytes, integrity(fixture.bytes), "0.1.0");
  const pkg = await manager.installer.load(id, "0.1.0"), candidateRoot = join(root, "candidate");
  await cp(pkg.root, candidateRoot, { recursive: true });
  const runtime = "export const createRuntime=()=>({describe:()=>({tools:[]}),health:()=>process.kill(process.pid,'SIGKILL'),invoke:()=>null});";
  await writeFile(join(candidateRoot, "dist/runtime.js"), runtime);
  const { sha256, validateHostedPackage } = await import("../src/host/server/plugins/hosted/resources.ts");
  const manifest = JSON.parse(await readFile(join(candidateRoot, "package.json"), "utf8")); manifest.version = "0.2.0";
  await atomicJson(join(candidateRoot, "package.json"), manifest);
  const resources = JSON.parse(await readFile(join(candidateRoot, "dist/resources.json"), "utf8"));
  Object.assign(resources.files.find((file: { path: string }) => file.path === "dist/runtime.js"), { bytes: Buffer.byteLength(runtime), sha256: sha256(runtime) });
  await atomicJson(join(candidateRoot, "dist/resources.json"), resources);
  const { HostedPluginSupervisor } = await import("../src/host/server/plugins/hosted/supervisor.ts");
  const broker = new HostedStateBroker(join(root, "data"), id), supervisor = new HostedPluginSupervisor(broker, entry);
  t.after(async () => { await supervisor.shutdown(); await rm(root, { recursive: true, force: true }); });
  await supervisor.replace(pkg); const active = (await broker.active())!, pid = supervisor.pid;
  const request = { requestId: "health-save", generation: active.generation, kind: "action" as const, action: "read", input: {}, scope: { cwd: root, sessionId: "s", workspaceId: "w" } };
  const saved = await broker.call(request, "workspace.commit", { path: "health.excalidraw", expectedHash: null, text: "keep bytes" });
  await broker.call(request, "state.compareAndSwap", { key: "draft", expectedRevision: 0, schema: 1, value: "keep state" });
  await assert.rejects(supervisor.replace(await validateHostedPackage(candidateRoot, id)), /exited|closed|disconnect/i);
  assert.equal(supervisor.pid, pid); assert.equal(supervisor.phase, "active"); assert.deepEqual(await broker.active(), active);
  assert.equal((await broker.call(request, "state.read", { key: "draft" }) as { value: string }).value, "keep state");
  assert.deepEqual(await broker.call(request, "workspace.read", { path: "health.excalidraw" }), { text: "keep bytes", ...(saved as { hash: string }) });
  assert.equal((await supervisor.invoke({ ...request, requestId: "old-still-live" }) as { version: string }).version, "0.1.0");
  await supervisor.shutdown();
});

test("interrupted archive and no-compatible release persist failures without replacing installed bytes", async t => {
  const root = await temporary(t), first = integrationFixture(), next = integrationFixture("0.2.0");
  let incompatible = false;
  const manager = new HostedPluginManager({ root, hostVersion: "0.1.29", workerEntry: "unused", hooks, fetch: (async url => {
    if (String(url).endsWith(".tgz")) return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(next.bytes.subarray(0, 30))); controller.error(new Error("network interrupted")); } }));
    return Response.json({ versions: incompatible ? { "0.2.0": { ...next.release, piWebapp: { ...next.release.piWebapp, hostRange: ">=9.0.0" } } } : { "0.2.0": next.release } });
  }) as typeof fetch });
  await manager.installer.installArchive(id, first.bytes, integrity(first.bytes), "0.1.0");
  const original = await manager.installer.load(id, "0.1.0");
  await manager.setPolicy(id, { updatePolicy: "automatic" });
  assert.equal(await manager.reconcileHostUpgrade(), false);
  assert.match((await manager.inventory()).plugins[0]!.updateDiagnostic!.message, /network interrupted/);
  incompatible = true;
  assert.equal(await manager.reconcileHostUpgrade(), false);
  const card = (await manager.inventory()).plugins[0]!;
  assert.match(card.updateDiagnostic!.message, /No compatible stable/); assert.equal(card.availableVersion, null);
  assert.equal(card.version, "0.1.0"); assert.equal((await manager.installer.load(id, "0.1.0")).digest, original.digest);
});

test("changing to pinned policy fences an already pending newer release", async t => {
  const root = await mkdtemp(join(tmpdir(), "hosted-pending-pin-")); let canSwitch = true;
  const manager = new HostedPluginManager({ root, hostVersion: "0.1.29", workerEntry: await worker(root), hooks: () => ({ ...hooks(), canSwitch: () => canSwitch }) });
  t.after(async () => { await manager.shutdown(); await rm(root, { recursive: true, force: true }); });
  for (const version of ["0.1.0", "0.2.0"]) { const fixture = integrationFixture(version); await manager.installer.installArchive(id, fixture.bytes, integrity(fixture.bytes), version); }
  await manager.manage(id, "enable", "0.1.0");
  const broker = new HostedStateBroker(join(root, "data"), id), before = await broker.active();
  canSwitch = false; await manager.manage(id, "enable", "0.2.0");
  assert.equal((await manager.inventory()).plugins[0]!.pendingVersion, "0.2.0");
  await manager.setPolicy(id, { updatePolicy: "pinned", pinnedVersion: "0.1.0" }); canSwitch = true;
  await assert.rejects(manager.manage(id, "retry"), /pin/i);
  assert.deepEqual(await broker.active(), before);
});

test("referenced fork refuses offline resolution even with stopped-owner confirmation", async t => {
  const root = await temporary(t), broker = new HostedStateBroker(root, id);
  const active = await broker.activate(0, { version: "0.1.0", stateRef: randomUUID(), schema: 1, enabled: true });
  await atomicJson(join(broker.root, "fork.json"), { version: 1, stateRef: active.stateRef });
  const report = await inspectStoppedStorage(broker.root);
  await assert.rejects(recoverStoppedFork(root, id, report.fingerprint, STOPPED_CONFIRMATION), /referenced/);
  assert.deepEqual(await broker.active(), active); assert.ok(await readFile(join(broker.root, "fork.json")));
});
