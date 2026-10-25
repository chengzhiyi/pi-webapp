import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import type { HostedInvocation } from "@chengzhiyi/pi-web-protocol";
import { HostedPluginManager } from "../src/host/server/plugins/hosted/manager.ts";
import { HostedPluginInstaller } from "../src/host/server/plugins/hosted/installer.ts";
import { HostedStateBroker } from "../src/host/server/plugins/hosted/state-broker.ts";
import { OFFICIAL_PLUGINS } from "../src/host/server/plugins/hosted/official-catalog.ts";
import { sha256 } from "../src/host/server/plugins/hosted/resources.ts";
import { atomicJson, withStorageLock } from "../src/host/server/plugins/hosted/storage.ts";

const id = OFFICIAL_PLUGINS[0]!.id;
const code = (expected: string) => (e: unknown) => (e as { code?: string }).code === expected;
function fixture(version: string) {
  const manifest = { apiVersion: 2, hostRange: ">=0.1.0 <1.0.0", runtimeProtocol: 1, backend: { entry: "./dist/runtime.js" }, frontend: { document: "./dist/frame.html", controller: "./dist/frame.html" }, resourcesManifest: "./dist/resources.json", dataSchemaVersion: 1, supportedDataSchemas: [1], capabilities: [...OFFICIAL_PLUGINS[0]!.requiredCapabilities] };
  const files = [
    { path: "dist/runtime.js", content: "export const createRuntime = () => ({describe:()=>({tools:[]}),health:()=>({ok:true}),invoke:()=>null,dispose(){}})", mime: "text/javascript" },
    { path: "dist/frame.html", content: "<!doctype html><html></html>", mime: "text/html" },
  ];
  const entries = [
    { path: "package/package.json", content: JSON.stringify({ name: id, version, type: "module", piWebapp: manifest }) },
    { path: "package/dist/resources.json", content: JSON.stringify({ version: 1, files: files.map(f => ({ path: f.path, bytes: Buffer.byteLength(f.content), sha256: sha256(f.content), mime: f.mime })) }) },
    ...files.map(f => ({ path: "package/" + f.path, content: f.content })),
  ];
  const parts: Buffer[] = [];
  for (const e of entries) {
    const data = Buffer.from(e.content), h = Buffer.alloc(512);
    h.write(e.path, 0, 100); h.write("0000600\0", 100); h.write("0000000\0", 108); h.write("0000000\0", 116);
    h.write(data.length.toString(8).padStart(11, "0") + "\0", 124); h.write("00000000000\0", 136); h.fill(32, 148, 156);
    h.write("0", 156); h.write("ustar\0", 257); h.write("00", 263);
    h.write([...h].reduce((a, b) => a + b, 0).toString(8).padStart(6, "0") + "\0 ", 148);
    parts.push(h, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  const bytes = gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
  const integrity = "sha512-" + createHash("sha512").update(bytes).digest("base64");
  return { bytes, integrity, release: { name: id, version, piWebapp: manifest, dist: { tarball: `https://registry.npmjs.org/fixture-${version}.tgz`, integrity } } };
}
async function temporary(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "pi-hosted-gc-"));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
function request(root: string, generation: number): HostedInvocation {
  return { requestId: randomUUID(), generation, scope: { cwd: root, workspaceId: "workspace", sessionId: "session" }, kind: "action", action: "fixture", input: {} };
}
async function setup(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "pi-hosted-gc-")), workerEntry = join(root, "worker.mjs");
  await build({ entryPoints: [new URL("../src/host/server/plugins/hosted/worker-entry.ts", import.meta.url).pathname], outfile: workerEntry, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  let current = fixture("0.1.0"), open = false, offline = false;
  const options = { root, workerEntry, hostVersion: "0.1.29", fetch: (async (url: string | URL | Request) => {
    if (offline) throw new Error("offline");
    return String(url).endsWith(".tgz") ? new Response(new Uint8Array(current.bytes)) : new Response(JSON.stringify({ versions: { [current.release.version]: current.release } }));
  }) as typeof fetch, hooks: () => ({ canSwitch: () => !open, freeze: async () => {}, resume: async () => {}, committed: async () => {} }) };
  const managers: HostedPluginManager[] = [], manager = new HostedPluginManager(options); managers.push(manager);
  t.after(async () => { try { for (const m of managers) await m.shutdown(); } finally { await rm(root, { recursive: true, force: true }); } });
  const broker = new HostedStateBroker(join(root, "data"), id);
  return { root, manager, broker, setVersion: (v: string) => { current = fixture(v); }, setOpen: (v: boolean) => { open = v; }, restart: () => { offline = true; const m = new HostedPluginManager(options); managers.push(m); return m; } };
}

test("50 actual replacement/GC cycles retain two code/state versions and latest accepted edits across offline restart", async t => {
  const { root, manager, broker, setVersion, restart } = await setup(t);
  await manager.manage(id, "install"); await manager.manage(id, "enable");
  for (let i = 1; i <= 50; i++) {
    const before = (await broker.active())!;
    await broker.call(request(root, before.generation), "state.compareAndSwap", { key: "draft", expectedRevision: i - 1, schema: 1, value: `accepted-${i}` });
    setVersion(`0.1.${i}`); await manager.manage(id, "update");
    const inventory = await manager.installer.inventory(), records = inventory.versions[id]!;
    assert.deepEqual(records.map(v => v.version), [`0.1.${i - 1}`, `0.1.${i}`]);
    assert.equal((await readdir(join(root, "packages", "versions", sha256(id)))).length, 2);
    assert.equal((await readdir(join(broker.root, "states"))).length, 2);
    for (const record of records) await manager.installer.load(id, record.version);
    assert.equal((await broker.call(request(root, (await broker.active())!.generation), "state.read", { key: "draft" }) as { value: string }).value, `accepted-${i}`);
  }
  await manager.shutdown(); const next = restart(); await next.start();
  assert.equal((await next.inventory()).plugins[0]!.enabled, true);
  assert.equal((await broker.call(request(root, (await broker.active())!.generation), "state.read", { key: "draft" }) as { value: string }).value, "accepted-50");
  await next.collect(id);
  assert.equal((await readdir(join(broker.root, "states"))).length, 2);
});

test("pending, pinned and installed-disabled references survive; uninstall preserves recovery and workspace bytes", async t => {
  const { root, manager, broker, setVersion, setOpen } = await setup(t);
  await manager.manage(id, "install"); await manager.manage(id, "enable");
  setVersion("0.1.1"); await manager.manage(id, "update");
  setOpen(true); setVersion("0.1.2"); assert.equal((await manager.manage(id, "update") as { pending: boolean }).pending, true);
  await manager.setPolicy(id, { updatePolicy: "pinned", pinnedVersion: "0.1.0" });
  await manager.collect(id);
  assert.deepEqual((await manager.installer.inventory()).versions[id]!.map(v => v.version), ["0.1.0", "0.1.1", "0.1.2"]);
  setOpen(false); await manager.manage(id, "retry"); await manager.collect(id);
  assert.deepEqual((await manager.installer.inventory()).versions[id]!.map(v => v.version), ["0.1.1", "0.1.2"]);
  await manager.manage(id, "disable"); setVersion("0.1.3"); await manager.manage(id, "update");
  assert.equal((await broker.active())!.enabled, false);
  assert.ok((await manager.installer.inventory()).versions[id]!.some(v => v.version === "0.1.3"));
  const states = await readdir(join(broker.root, "states"));
  await writeFile(join(root, "user.excalidraw"), "user bytes");
  await manager.manage(id, "uninstall");
  assert.deepEqual(await readdir(join(broker.root, "states")), states);
  assert.equal(await readFile(join(root, "user.excalidraw"), "utf8"), "user bytes");
  assert.ok(await readFile(join(broker.root, "previous.json")));
});

test("state GC refuses unresolved journals/forks, missing references and unsafe trees before deleting anything", async t => {
  const root = await temporary(t), b = new HostedStateBroker(root, id);
  const a = await b.activate(0, { version: "0.1.0", stateRef: randomUUID(), schema: 1, enabled: true });
  const orphan = randomUUID(); await mkdir(join(b.root, "states", orphan));
  for (const name of ["transition.json", "fork.json"]) {
    await atomicJson(join(b.root, name), { future: "unknown" });
    await assert.rejects(b.collect(async () => {}), code("gc_recovery_required"));
    assert.ok((await readdir(join(b.root, "states"))).includes(orphan));
    await writeFile(join(b.root, name), "null");
    await assert.rejects(b.collect(async () => {}), code("gc_recovery_required"));
    await rm(join(b.root, name));
  }
  const bad = join(b.root, "states", randomUUID()); await symlink(root, bad);
  await assert.rejects(b.collect(async () => {}), code("gc_recovery_required")); await rm(bad);
  await rm(join(b.root, "states", a.stateRef), { recursive: true });
  await assert.rejects(b.collect(async () => {}), code("gc_recovery_required"));
  assert.ok((await readdir(join(b.root, "states"))).includes(orphan));
});

test("fork reservation fences GC until commit; CAS and GC serialize across broker instances", async t => {
  const root = await temporary(t), b = new HostedStateBroker(root, id), other = new HostedStateBroker(root, id);
  const a = await b.activate(0, { version: "0.1.0", stateRef: randomUUID(), schema: 1, enabled: true });
  const ref = await b.forkState(a.generation);
  await assert.rejects(other.collect(async () => {}), code("gc_recovery_required"));
  const next = await b.activate(1, { version: "0.1.1", stateRef: ref, schema: 1, enabled: true });
  await Promise.all([other.collect(async () => {}), b.call(request(root, next.generation), "state.compareAndSwap", { key: "draft", expectedRevision: 0, schema: 1, value: "latest" })]);
  assert.equal((await b.call(request(root, next.generation), "state.read", { key: "draft" }) as { value: string }).value, "latest");
});

test("crash GC journal resumes committed deletion, aborts precommit deletion, and refuses unknown schema", async t => {
  const root = await temporary(t), i = new HostedPluginInstaller({ root, hostVersion: "0.1.29" });
  for (const version of ["0.1.0", "0.1.1"]) { const f = fixture(version); await i.installArchive(id, f.bytes, f.integrity, version); }
  const records = (await i.inventory()).versions[id]!;
  await atomicJson(join(root, "gc-journal.json"), { schema: 1, pluginId: id, records: [records[0]] });
  assert.equal((await i.inventory()).versions[id]!.length, 2); await i.load(id, "0.1.0");
  const index = JSON.parse(await readFile(join(root, "installed.json"), "utf8"));
  index.versions[id] = [records[1]]; index.revision++;
  await atomicJson(join(root, "gc-journal.json"), { schema: 1, pluginId: id, records: [records[0]] });
  await atomicJson(join(root, "installed.json"), index);
  await i.inventory(); assert.equal((await readdir(join(root, "versions", sha256(id)))).length, 1);
  await i.load(id, "0.1.1");
  await writeFile(join(root, "gc-journal.json"), "null");
  await assert.rejects(i.collect(id, async () => []), code("gc_recovery_required"));
  await atomicJson(join(root, "gc-journal.json"), { schema: 99, pluginId: id, records: [records[1]] });
  await assert.rejects(i.collect(id, async () => []), code("gc_recovery_required"));
  assert.equal((await readdir(join(root, "versions", sha256(id)))).length, 1);
});

test("GC failures preserve all references and partial orphan-state cleanup is safely repeatable", async t => {
  const { root, manager, broker, setVersion } = await setup(t);
  await manager.manage(id, "install"); await manager.manage(id, "enable");
  setVersion("0.1.1"); await manager.manage(id, "update");
  const active = (await broker.active())!;
  await broker.call(request(root, active.generation), "state.compareAndSwap", { key: "draft", expectedRevision: 0, schema: 1, value: "post-commit edit" });
  const orphan = randomUUID(), directory = join(broker.root, "states", orphan);
  await mkdir(directory);
  const intent = join(directory, `${"a".repeat(64)}.json`);
  await atomicJson(intent, { requestId: "lost-save", inputHash: "b".repeat(64), nextHash: "c".repeat(64), committed: false });
  await assert.rejects(manager.collect(id), code("gc_recovery_required"));
  assert.equal((await manager.inventory()).plugins[0]!.error!.code, "gc_recovery_required");
  assert.equal((await manager.installer.inventory()).versions[id]!.length, 2);
  assert.equal((await broker.call(request(root, active.generation), "state.read", { key: "draft" }) as { value: string }).value, "post-commit edit");
  // Model an operator-reconciled intent, then a crash midway through deleting an inert snapshot.
  await rm(intent); await manager.collect(id); await manager.collect(id);
  assert.equal((await readdir(join(broker.root, "states"))).length, 2);
  const previous = JSON.parse(await readFile(join(broker.root, "previous.json"), "utf8"));
  // Model a crash after active.json committed, but before previous.json was updated.
  const ref = await broker.forkState(active.generation);
  const next = { ...active, version: "0.1.1", generation: active.generation + 1, stateRef: ref, operationId: randomUUID() };
  await atomicJson(join(broker.root, "transition.json"), { version: 1, before: active, next });
  await atomicJson(join(broker.root, "active.json"), next);
  assert.equal((await broker.recover()).recovered, "committed");
  assert.equal(JSON.parse(await readFile(join(broker.root, "previous.json"), "utf8")).stateRef, active.stateRef);
  assert.notEqual(previous.stateRef, active.stateRef);
  await manager.collect(id);
  assert.equal((await broker.call(request(root, next.generation), "state.read", { key: "draft" }) as { value: string }).value, "post-commit edit");
});

test("external installation and GC share disk lock and references are sampled after admission", async t => {
  const root = await temporary(t), i = new HostedPluginInstaller({ root, hostVersion: "0.1.29" });
  for (const version of ["0.1.0", "0.1.1", "0.1.2"]) { const f = fixture(version); await i.installArchive(id, f.bytes, f.integrity, version); }
  let release!: () => void, entered!: () => void;
  const admitted = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
  const held = withStorageLock(root, async () => { entered(); await gate; }); await admitted;
  let sampled = false;
  const gc = i.collect(id, async () => { sampled = true; return ["0.1.0"]; });
  const f = fixture("0.1.3"), install = i.installArchive(id, f.bytes, f.integrity, "0.1.3");
  assert.equal(sampled, false); release(); await held; await Promise.all([gc, install]);
  await i.load(id, "0.1.0"); await i.load(id, "0.1.3");
});
