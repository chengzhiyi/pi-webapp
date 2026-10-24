import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { build } from "esbuild";
import type { HostedInvocation, HostedStateRecord } from "@chengzhiyi/pi-web-protocol";
import { isHostedPluginManifest } from "@chengzhiyi/pi-web-protocol";
import { hostedAsset, sha256, validateHostedPackage } from "../src/host/server/plugins/hosted/resources.ts";
import { HostedStateBroker } from "../src/host/server/plugins/hosted/state-broker.ts";
import { HostedPluginSupervisor, type HostedSwitchHooks } from "../src/host/server/plugins/hosted/supervisor.ts";
import { HostedRuntimeProcess } from "../src/host/server/plugins/hosted/runtime-process.ts";
import { atomicJson } from "../src/host/server/plugins/hosted/storage.ts";

const runtime = `export async function createRuntime(ctx) { return {
  describe: () => ({ tools: [{ name: 'fixture_diagram', label: 'Fixture', description: 'Fixture tool', parameters: {type:'object',properties:{}}, action: 'read' }] }),
  health: () => { if (ctx.version === '99.0.0') throw new Error('health failed'); return {ok:true}; },
  async invoke(r) {
    if(r.action === 'wait') { await new Promise(resolve=>setTimeout(resolve,r.input.ms)); return {version:ctx.version,generation:ctx.generation}; }
    if(r.action === 'env') return Object.keys(process.env);
    if(r.action === 'late') { setTimeout(()=>ctx.broker.call('state.compareAndSwap',{key:'late',expectedRevision:0,schema:1,value:'bad'}).catch(()=>{}),50); return 'scheduled'; }
    if(r.action === 'broker') return ctx.broker.call(r.input.method,r.input.input);
    return {version:ctx.version,generation:ctx.generation};
  }, dispose() {}
}; }`;
async function fixture(root: string, version = "1.0.0") {
  const directory = join(root, `package-${version}`); await mkdir(join(directory, "dist/fonts"), { recursive: true });
  const manifest = { apiVersion: 2, hostRange: ">=0.1.29", runtimeProtocol: 1, backend: { entry: "./dist/runtime.js" }, frontend: { document: "./dist/index.html", controller: "./dist/index.html" }, resourcesManifest: "./dist/resources.json", dataSchemaVersion: 1, supportedDataSchemas: [1], capabilities: ["lifecycle", "state.cas"] };
  const files: Array<{ path: string; bytes: number; sha256: string; mime: string }> = [];
  for (const [path, content, mime] of [["dist/runtime.js", runtime, "text/javascript"], ["dist/index.html", "<!doctype html><title>fixture</title>", "text/html"], ["dist/fonts/local.woff2", "font-fixture", "font/woff2"]]) {
    await writeFile(join(directory, path!), content!); files.push({ path: path!, bytes: Buffer.byteLength(content!), sha256: sha256(content!), mime: mime! });
  }
  await writeFile(join(directory, "dist/resources.json"), JSON.stringify({ version: 1, files }));
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: "@example/hosted", version, type: "module", piWebapp: manifest }));
  return { directory, manifest, files };
}
const errorCode = (code: string) => (error: unknown) => (error as { code?: string }).code === code;
const disposers = new Map<string, Array<() => Promise<unknown>>>();
function disposeBeforeStorage(root: string, fn: () => Promise<unknown>) { disposers.get(root)!.push(fn); }
async function temporary(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "pi-hosted-")); disposers.set(root, []);
  t.after(async () => { try { for (const dispose of disposers.get(root)!) await dispose(); } finally { disposers.delete(root); await rm(root, { recursive: true, force: true }); } });
  return root;
}
function request(cwd: string, generation = 1, sessionId = "session"): HostedInvocation {
  return { requestId: randomUUID(), generation, scope: { cwd, workspaceId: "workspace", sessionId }, kind: "action", action: "test", input: {} };
}
async function workerEntry(root: string) {
  const entry = join(root, "worker.mjs");
  await build({ entryPoints: [new URL("../src/host/server/plugins/hosted/worker-entry.ts", import.meta.url).pathname], outfile: entry, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  return entry;
}

test("v2 manifest paths reject traversal, double encodings and unsupported schema/protocol", () => {
  const manifest = { apiVersion: 2, hostRange: ">=0.1.29", runtimeProtocol: 1, backend: { entry: "./dist/runtime.js" }, frontend: { document: "./dist/index.html", controller: "./dist/index.html" }, resourcesManifest: "./dist/resources.json", dataSchemaVersion: 1, supportedDataSchemas: [1], capabilities: [] };
  assert.equal(isHostedPluginManifest(manifest), true);
  for (const entry of ["./dist/../runtime.js", "./dist/%252e/runtime.js", "C:/dist/runtime.js", "./dist//runtime.js"]) assert.equal(isHostedPluginManifest({ ...manifest, backend: { entry } }), false);
  assert.equal(isHostedPluginManifest({ ...manifest, runtimeProtocol: 2 }), false);
  assert.equal(isHostedPluginManifest({ ...manifest, supportedDataSchemas: [2] }), false);
});

test("resource manifests permit fonts/nested assets, serve immutable declarations only, and detect changed bytes", async t => {
  const root = await temporary(t), f = await fixture(root), pkg = await validateHostedPackage(f.directory, "@example/hosted");
  assert.equal((await hostedAsset(pkg, "dist/fonts/local.woff2", pkg.digest))?.mime, "font/woff2");
  for (const path of ["dist/runtime.js", "package.json", "dist/%2e%2e/package.json", "dist/%252e%252e/package.json", "dist/unknown.js"]) assert.equal(await hostedAsset(pkg, path, pkg.digest), null);
  assert.equal(await hostedAsset(pkg, "dist/index.html", "old-digest"), null);
  await writeFile(join(f.directory, "dist/index.html"), "modified");
  await assert.rejects(hostedAsset(pkg, "dist/index.html", pkg.digest), errorCode("resource_changed"));
});

test("package validation rejects undeclared code, hashes, links, MIME mismatch and install scripts", async t => {
  const root = await temporary(t), f = await fixture(root);
  await writeFile(join(f.directory, "extra.js"), "export default 'undeclared'");
  await assert.rejects(validateHostedPackage(f.directory), /package-root/); await rm(join(f.directory, "extra.js"));
  await writeFile(join(f.directory, "dist/extra.js"), "export default 1");
  await assert.rejects(validateHostedPackage(f.directory), /Undeclared/); await rm(join(f.directory, "dist/extra.js"));
  f.files[0]!.sha256 = "0".repeat(64); await writeFile(join(f.directory, "dist/resources.json"), JSON.stringify({ version: 1, files: f.files }));
  await assert.rejects(validateHostedPackage(f.directory), /integrity/); f.files[0]!.sha256 = sha256(runtime);
  f.files[0]!.mime = "text/html"; await writeFile(join(f.directory, "dist/resources.json"), JSON.stringify({ version: 1, files: f.files }));
  await assert.rejects(validateHostedPackage(f.directory), /MIME/); f.files[0]!.mime = "text/javascript";
  await writeFile(join(f.directory, "dist/resources.json"), JSON.stringify({ version: 1, files: f.files }));
  await rm(join(f.directory, "dist/fonts/local.woff2")); await writeFile(join(root, "outside"), "font-fixture"); await symlink(join(root, "outside"), join(f.directory, "dist/fonts/local.woff2"));
  await assert.rejects(validateHostedPackage(f.directory), /Links/);
  await rm(join(f.directory, "dist/fonts/local.woff2")); await writeFile(join(f.directory, "dist/fonts/local.woff2"), "font-fixture");
  const pkg = JSON.parse(await readFile(join(f.directory, "package.json"), "utf8")); pkg.scripts = { postinstall: "echo must-not-run" };
  await writeFile(join(f.directory, "package.json"), JSON.stringify(pkg)); await assert.rejects(validateHostedPackage(f.directory), /lifecycle/);
});

test("persistent state enforces CAS across independent brokers, scope isolation and old-generation write fencing", async t => {
  const root = await temporary(t), a = new HostedStateBroker(root, "fixture"), b = new HostedStateBroker(root, "fixture");
  const stateRef = randomUUID(); await a.activate(0, { version: "1.0.0", schema: 1, stateRef, enabled: true });
  const r = request(root), input = { key: "scope", expectedRevision: 0, schema: 1, value: { text: "手改", revision: 7 } };
  const attempts = await Promise.allSettled([a.call(r, "state.compareAndSwap", input), b.call({ ...r, requestId: randomUUID() }, "state.compareAndSwap", input)]);
  assert.equal(attempts.filter(v => v.status === "fulfilled").length, 1);
  const winner = attempts[0]!.status === "fulfilled" ? r : { ...r, requestId: "not-replaying-winner" };
  if (attempts[0]!.status === "fulfilled") assert.deepEqual(await a.call(winner, "state.compareAndSwap", input), (attempts[0] as PromiseFulfilledResult<unknown>).value);
  assert.equal(await b.call(request(root, 1, "other"), "state.read", { key: "scope" }), null);
  assert.equal(await new HostedStateBroker(root, "other").active(), null);
  const forked = await a.forkState(1);
  await a.activate(1, { version: "2.0.0", schema: 1, stateRef: forked, enabled: true });
  await assert.rejects(b.call(r, "state.compareAndSwap", { ...input, expectedRevision: 1, value: "stale" }), errorCode("stale_generation"));
  assert.deepEqual((await a.call(request(root, 2), "state.read", { key: "scope" }) as HostedStateRecord).value, input.value);
  await assert.rejects(a.activate(1, { version: "old", schema: 1, stateRef, enabled: true }), errorCode("stale_generation"));
});

test("workspace saves retain hash/no-replace protection and reject actual stale-generation disk writes", async t => {
  const root = await temporary(t), cwd = join(root, "workspace"); await mkdir(cwd);
  const b = new HostedStateBroker(join(root, "state"), "fixture");
  const a = await b.activate(0, { version: "1.0.0", schema: 1, stateRef: randomUUID(), enabled: true });
  const r = request(cwd), input = { path: "diagrams/a.excalidraw", text: '{"手改":1}', expectedHash: null };
  const saved = await b.call(r, "workspace.commit", input) as { hash: string };
  assert.equal(saved.hash, sha256(input.text)); assert.deepEqual(await b.call(r, "workspace.commit", input), saved);
  await assert.rejects(b.call(request(cwd), "workspace.commit", input), errorCode("file_conflict"));
  await writeFile(join(cwd, input.path), "external");
  await assert.rejects(b.call(request(cwd), "workspace.commit", { ...input, expectedHash: saved.hash }), errorCode("file_conflict"));
  await b.activate(1, { ...a, version: "2.0.0", enabled: true });
  await assert.rejects(b.call(r, "workspace.commit", { ...input, text: "stale", expectedHash: sha256("external") }), errorCode("stale_generation"));
  assert.equal(await readFile(join(cwd, input.path), "utf8"), "external");
  for (const path of ["../escape.excalidraw", "/escape.excalidraw", "C:/escape.excalidraw", "diagrams/a.txt"]) await assert.rejects(b.call(request(cwd, 2), "workspace.commit", { ...input, path }), errorCode("invalid_path"));
  await symlink(join(root, "outside"), join(cwd, "linked.excalidraw"));
  await assert.rejects(b.call(request(cwd, 2), "workspace.commit", { ...input, path: "linked.excalidraw" }), errorCode("invalid_path"));
});

test("transition recovery follows the committed active pointer, never an old snapshot", async t => {
  const root = await temporary(t), b = new HostedStateBroker(root, "fixture");
  const before = await b.activate(0, { version: "1.0.0", schema: 1, stateRef: randomUUID(), enabled: true });
  const next = { ...before, version: "2.0.0", generation: 2, operationId: randomUUID() };
  await atomicJson(join(b.root, "transition.json"), { before, next });
  assert.equal((await b.recover()).recovered, "not_committed"); assert.deepEqual(await b.active(), before);
  await atomicJson(join(b.root, "transition.json"), { before, next }); await atomicJson(join(b.root, "active.json"), next);
  assert.equal((await b.recover()).recovered, "committed"); assert.deepEqual(await b.active(), next);
  await writeFile(join(b.root, "active.json"), "{broken");
  await assert.rejects(b.recover(), errorCode("invalid_storage")); assert.equal(await readFile(join(b.root, "active.json"), "utf8"), "{broken");
});

test("subprocess replacement retains host PID, old call leases and state; failed candidate keeps old version", async t => {
  const root = await temporary(t), entry = await workerEntry(root), first = await fixture(root), second = await fixture(root, "2.0.0"), bad = await fixture(root, "99.0.0");
  const b = new HostedStateBroker(join(root, "state"), "@example/hosted"), supervisor = new HostedPluginSupervisor(b, entry), hostPid = process.pid;
  disposeBeforeStorage(root, () => supervisor.disable());
  await supervisor.replace(await validateHostedPackage(first.directory));
  const oldPid = supervisor.pid;
  const invoke = (action: string, input: unknown = {}) => supervisor.invoke({ ...request(root), action, input });
  await assert.rejects(supervisor.replace(await validateHostedPackage(bad.directory)), /health failed/);
  assert.equal(supervisor.pid, oldPid); assert.equal((await invoke("read") as { version: string }).version, "1.0.0");
  await invoke("broker", { method: "state.compareAndSwap", input: { key: "scope", expectedRevision: 0, schema: 1, value: "手改" } });
  const pending = invoke("wait", { ms: 150 });
  const switched = supervisor.replace(await validateHostedPackage(second.directory));
  assert.equal((await pending as { version: string }).version, "1.0.0"); await switched;
  assert.notEqual(supervisor.pid, oldPid); assert.equal(process.pid, hostPid);
  assert.equal((await invoke("broker", { method: "state.read", input: { key: "scope" } }) as HostedStateRecord).value, "手改");
  assert.throws(() => process.kill(oldPid!, 0));
  assert.equal(supervisor.generation, 2);
});

test("open editors defer activation; freeze failure preserves old runtime; host FlushBarrier can synchronize while draining", async t => {
  const root = await temporary(t), entry = await workerEntry(root), first = await fixture(root), second = await fixture(root, "2.0.0");
  const b = new HostedStateBroker(join(root, "state"), "@example/hosted"); let editorOpen = false, freezeFails = false, resumes = 0;
  let supervisor: HostedPluginSupervisor;
  const hooks: HostedSwitchHooks = { canSwitch: () => !editorOpen, freeze: async () => {
    if (freezeFails) throw new Error("unsynchronized edits");
    if (supervisor.generation) await supervisor.flushAction({ ...request(root), action: "read" });
  }, committed: async () => {}, resume: async () => { resumes++; } };
  supervisor = new HostedPluginSupervisor(b, entry, hooks); disposeBeforeStorage(root, () => supervisor.disable());
  await supervisor.replace(await validateHostedPackage(first.directory)); const oldPid = supervisor.pid;
  editorOpen = true; assert.deepEqual(await supervisor.replace(await validateHostedPackage(second.directory)), { pending: true });
  assert.equal(supervisor.pendingVersion, "2.0.0"); assert.equal(supervisor.pid, oldPid);
  editorOpen = false; freezeFails = true; await assert.rejects(supervisor.retryPending(), /unsynchronized edits/);
  assert.equal(supervisor.pid, oldPid); assert.equal(supervisor.phase, "active"); assert.equal(resumes, 1);
  freezeFails = false; await supervisor.retryPending(); assert.equal(supervisor.pendingVersion, null); assert.notEqual(supervisor.pid, oldPid);
});

test("timed out invocations keep drain leases; stale background broker calls and secrets are blocked", async t => {
  const root = await temporary(t), entry = await workerEntry(root), f = await fixture(root), pkg = await validateHostedPackage(f.directory);
  const b = new HostedStateBroker(join(root, "state"), pkg.id); await b.activate(0, { version: pkg.version, schema: 1, stateRef: randomUUID(), enabled: true });
  const worker = await HostedRuntimeProcess.start(pkg, 1, entry, (r, method, input) => b.call(r, method, input));
  disposeBeforeStorage(root, async () => { await worker.waitForIdle(); await worker.dispose(); });
  const vars = await worker.invoke({ ...request(root), action: "env" }) as string[];
  assert.equal(vars.some(key => /PAPERCLIP|PI_|TOKEN|KEY|NODE_OPTIONS/.test(key)), false);
  await worker.invoke({ ...request(root), action: "late" }); await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(await b.call(request(root), "state.read", { key: "late" }), null);
  await assert.rejects(worker.invoke({ ...request(root), action: "wait", input: { ms: 120 } }, 10), errorCode("worker_timeout"));
  assert.equal(worker.inFlight, 1); assert.equal(await worker.waitForIdle(10), false);
  await assert.rejects(worker.dispose(), errorCode("worker_busy"));
  assert.equal(await worker.waitForIdle(1000), true); await worker.dispose();
});

test("independent supervisors cannot silently steal a live runtime; shutdown retains enabled intent", async t => {
  const root = await temporary(t), entry = await workerEntry(root), f = await fixture(root), pkg = await validateHostedPackage(f.directory);
  const b = new HostedStateBroker(join(root, "state"), pkg.id), first = new HostedPluginSupervisor(b, entry);
  const second = new HostedPluginSupervisor(new HostedStateBroker(join(root, "state"), pkg.id), entry);
  disposeBeforeStorage(root, () => first.shutdown()); disposeBeforeStorage(root, () => second.shutdown());
  await first.replace(pkg);
  await assert.rejects(second.replace(pkg), errorCode("runtime_owned"));
  assert.equal((await first.invoke({ ...request(root), action: "read" }) as { version: string }).version, "1.0.0");
  await first.shutdown(); assert.equal((await b.active())?.enabled, true);
  await second.replace(pkg); assert.equal(second.phase, "active");
  const generation = (await b.active())!.generation;
  await assert.rejects(second.replace({ ...pkg, manifest: { ...pkg.manifest, dataSchemaVersion: 2, supportedDataSchemas: [1, 2] } }), errorCode("migration_required"));
  assert.equal((await b.active())?.generation, generation);
  await second.disable(); assert.equal((await b.active())?.enabled, false);
});

test("50 enable/disable cycles leave no old processes and preserve persistent state", async t => {
  const root = await temporary(t), entry = await workerEntry(root), f = await fixture(root), pkg = await validateHostedPackage(f.directory);
  const b = new HostedStateBroker(join(root, "state"), pkg.id), s = new HostedPluginSupervisor(b, entry);
  disposeBeforeStorage(root, () => s.disable()); const pids: number[] = [];
  for (let i = 0; i < 50; i++) {
    await s.replace(pkg); pids.push(s.pid!);
    if (i === 0) await s.invoke({ ...request(root), action: "broker", input: { method: "state.compareAndSwap", input: { key: "scope", expectedRevision: 0, schema: 1, value: "keep" } } });
    assert.equal((await s.invoke({ ...request(root), action: "broker", input: { method: "state.read", input: { key: "scope" } } }) as HostedStateRecord).value, "keep");
    await s.disable(); assert.equal(s.phase, "disabled"); assert.equal(s.pid, undefined); assert.equal((await b.active())?.enabled, false);
  }
  for (const pid of pids) assert.throws(() => process.kill(pid, 0));
  assert.equal((await readdir(join(b.root, "states"))).length, 50); // GC is intentionally not claimed by this primitive.
});
