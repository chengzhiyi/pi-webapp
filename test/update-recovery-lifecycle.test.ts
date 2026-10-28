import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import { HostedPluginManager } from "../src/host/server/plugins/hosted/manager.ts";
import { SelfUpdater } from "../src/host/server/updates/self-update.ts";
import { fingerprint, readPair } from "../src/host/server/updates/hosted-pair.ts";
import { integrationFixture, hostedId, integrity } from "./helpers/hosted-integration-fixture.ts";

// Real manager, worker, storage and updater; only the public registry/npm transport is a fixture.
async function setup(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "update-recovery-"));
  const worker = join(root, "worker.js"), packageRoot = join(root, "current"), storage = join(root, "hosted");
  await build({ entryPoints: [new URL("../src/host/server/plugins/hosted/worker-entry.ts", import.meta.url).pathname], outfile: worker, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  const workerBytes = await readFile(worker);
  async function host(path: string, version: string) {
    await Promise.all(["dist", "bin", "web/dist"].map(dir => mkdir(join(path, dir), { recursive: true })));
    await writeFile(join(path, "package.json"), JSON.stringify({ name: "pi-webapp", version, piWebappHostedRuntime: { protocol: 2, runtimeProtocol: 1, pairJournal: 1, ownershipProtocol: 2, capabilities: ["state", "workspace", "legacy", "panels", "messages"] } }));
    await writeFile(join(path, "dist/hosted-worker.js"), workerBytes);
    for (const file of ["bin/pi-webapp.mjs", "dist/extension.js", "web/dist/index.html"]) await writeFile(join(path, file), "fixture; not executed");
  }
  await host(packageRoot, "0.1.36");
  const archive = integrationFixture("0.1.0", false, ">=0.1.0 <1.0.0");
  const manager = new HostedPluginManager({ root: storage, workerEntry: worker, hostVersion: "0.1.36", packageRoot,
    hooks: () => ({ canSwitch: () => true, freeze: async () => {}, resume: async () => {}, committed: async () => {} }),
    fetch: (async () => Response.json({ versions: { "0.1.0": archive.release } })) as typeof fetch });
  t.after(async () => { await manager.shutdown(); await rm(root, { recursive: true, force: true }); });
  await manager.installer.installArchive(hostedId, archive.bytes, integrity(archive.bytes), "0.1.0");
  await manager.manage(hostedId, "enable");
  let failDrain = false, suspended = false;
  let npmInstall: ((signal?: AbortSignal) => Promise<void>) | undefined;
  const pair = manager.hostPair;
  const updater = new SelfUpdater({ agentDir: root, packageRoot, launcherNonce: "fixture", hostedPair: pair,
    beforeRestart: async () => {
      if (failDrain) throw new Error("Close editors before updating; old version retained");
      const resume = await manager.suspendForRestart(); suspended = true;
      return async () => { await resume(); suspended = false; };
    },
    runNpm: async (args, signal) => {
      if (args[0] === "view") return args.includes("dist-tags") ? JSON.stringify({ latest: "0.1.37", alpha: "0.1.38-alpha.1" }) : JSON.stringify("0.1.37");
      await npmInstall?.(signal);
      const version = args[1]!.slice("pi-webapp@".length), prefix = args[args.indexOf("--prefix") + 1]!;
      await host(join(prefix, "node_modules/pi-webapp"), version); return "";
    } });
  return { root, storage, packageRoot, host, updater, manager, pair, get suspended() { return suspended; }, failDrain: () => { failDrain = true; },
    npmInstall: (next: (signal?: AbortSignal) => Promise<void>) => { npmInstall = next; } };
}

test("download and prepare do not select a release or prevent independent plugin lifecycle", async t => {
  const f = await setup(t);
  await f.updater.prepare();
  await assert.rejects(readFile(join(f.root, "pi-web/update.json")), { code: "ENOENT" });
  assert.equal((await readPair(f.storage))?.phase, "prepared");
  await f.manager.manage(hostedId, "disable");
  await f.manager.manage(hostedId, "enable");
  assert.equal(f.manager.tools.length, 1);
});

test("legacy selected journal has a safe online cancel entry without changing plugin state or deleting evidence", async t => {
  const f = await setup(t), next = join(f.root, "legacy-next"), pointer = join(f.root, "pi-web/update.json");
  await f.host(next, "0.1.37"); await mkdir(join(f.root, "pi-web"), { recursive: true });
  await f.pair.select("0.1.37", next, async () => {
    const bytes = Buffer.from(JSON.stringify({ version: "0.1.37", launcher: join(next, "bin/pi-webapp.mjs"), baseVersion: "0.1.36" }));
    await writeFile(pointer, bytes); return { path: pointer, digest: fingerprint(bytes.toString("base64")) };
  });
  const before = await f.manager.pairSnapshot();
  const launcherState = join(f.root, "pi-web/launcher.json"), marker = join(f.root, "pi-web/launcher.restart");
  await writeFile(launcherState, JSON.stringify({ nonce: "another-live-owner", version: "0.1.36", piPid: process.pid }));
  await assert.rejects(f.updater.cancel(), /归属|交接|实例/);
  assert.equal(JSON.parse(await readFile(pointer, "utf8")).version, "0.1.37");
  await writeFile(launcherState, JSON.stringify({ nonce: "fixture", version: "0.1.36", piPid: process.pid }));
  await writeFile(marker, JSON.stringify({ nonce: "fixture", launcher: join(next, "bin/pi-webapp.mjs") }));
  await assert.rejects(f.updater.cancel(), /归属|交接|实例/);
  await rm(marker);
  await f.updater.cancel();
  assert.deepEqual(await f.manager.pairSnapshot(), before);
  assert.equal(JSON.parse(await readFile(pointer, "utf8")).version, "0.1.36");
  assert.equal((await readPair(f.storage))!.phase, "cancelled");
  const disk = JSON.parse(await readFile(join(f.storage, "host-pair/intent.json"), "utf8"));
  assert.equal(disk.phase, "reconciled", "the schema-1 fallback reader recognizes the terminal disk phase");
  assert.equal(disk.lifecyclePhase, "cancelled");
  await f.manager.manage(hostedId, "disable"); await f.manager.manage(hostedId, "enable");
  assert.equal(JSON.parse(await readFile(join(f.root, "pi-web/update-transaction.json"), "utf8")).phase, "cancelled");
});

test("restart intent is durable before handoff and retains a schema-1-readable disk phase", async t => {
  const f = await setup(t), prepared = await f.updater.prepare(), restart = f.pair.restart;
  let authorized = false;
  f.pair.restart = (version, packageRoot, writeRestart) => restart(version, packageRoot, async () => {
    const pair = JSON.parse(await readFile(join(f.storage, "host-pair/intent.json"), "utf8"));
    assert.equal(pair.phase, "selected"); assert.equal(pair.lifecyclePhase, "restart-requested"); authorized = true;
    await writeRestart();
    const transaction = JSON.parse(await readFile(join(f.root, "pi-web/update-transaction.json"), "utf8"));
    assert.equal(transaction.phase, "restart-requested");
  });
  await f.updater.requestRestart(prepared); assert.equal(authorized, true);
  assert.equal((await readPair(f.storage))!.phase, "restart-requested");
});

test("a process-exit snapshot before pointer rename cancels without rewriting the exact previous pointer", async t => {
  const f = await setup(t), next = join(f.root, "pre-rename-next"), pointer = join(f.root, "pi-web/update.json");
  await f.host(next, "0.1.37"); await mkdir(join(f.root, "pi-web"), { recursive: true });
  const before = Buffer.from(JSON.stringify({ version: "0.1.36", launcher: join(f.packageRoot, "bin/pi-webapp.mjs"), baseVersion: "0.1.36" }));
  const candidate = Buffer.from(JSON.stringify({ version: "0.1.37", launcher: join(next, "bin/pi-webapp.mjs"), baseVersion: "0.1.36" }));
  await writeFile(pointer, before);
  await assert.rejects(f.pair.select("0.1.37", next, async () => { throw new Error("injected exit before rename"); }), /before rename/);
  // Fault snapshot: durable intent was written, but the attempted rename never happened.
  await writeFile(join(f.root, "pi-web/update-transaction.json"), JSON.stringify({ schema: 1, id: (await readPair(f.storage))!.id,
    phase: "selecting", version: "0.1.37", channel: "stable", packageRoot: next, selectionPath: pointer,
    before: before.toString("base64"), selectedDigest: fingerprint(candidate.toString("base64")) }));
  await f.updater.cancel();
  assert.deepEqual(await readFile(pointer), before);
  assert.equal((await readPair(f.storage))!.phase, "cancelled"); assert.equal(f.manager.tools.length, 1);
  await f.manager.manage(hostedId, "disable"); await f.manager.manage(hostedId, "enable");
});

test("failed restart marker restores the prior pointer and exact live generation, cancellation is idempotent", async t => {
  const f = await setup(t), generation = f.manager.tools[0]!.generation, prepared = await f.updater.prepare();
  await mkdir(join(f.root, "pi-web/launcher.restart")); // Real filesystem failure after pointer selection.
  await assert.rejects(f.updater.requestRestart(prepared), /EISDIR|EEXIST/);
  assert.equal(f.suspended, false);
  assert.equal(f.manager.tools[0]!.generation, generation);
  await assert.rejects(readFile(join(f.root, "pi-web/update.json")), { code: "ENOENT" });
  assert.equal((await readPair(f.storage))!.phase, "cancelled");
  await f.updater.cancel(); await f.updater.cancel();
  await f.manager.manage(hostedId, "disable"); await f.manager.manage(hostedId, "uninstall");
  assert.equal((await f.manager.inventory()).plugins[0]!.installed, false);
});

test("a competing pointer is never overwritten when restart fails; the original worker still resumes", async t => {
  const f = await setup(t), generation = f.manager.tools[0]!.generation, prepared = await f.updater.prepare();
  const foreign = JSON.stringify({ version: "0.9.0", launcher: "another-owner" });
  f.pair.restart = async () => { await writeFile(join(f.root, "pi-web/update.json"), foreign); throw new Error("injected restart refusal"); };
  await assert.rejects(f.updater.requestRestart(prepared), /其他操作更改/);
  assert.equal(await readFile(join(f.root, "pi-web/update.json"), "utf8"), foreign);
  assert.equal(f.manager.tools[0]!.generation, generation); assert.equal(f.suspended, false);
});

test("cancelling a running download aborts transport and retains current code and plugin data", async t => {
  const f = await setup(t); let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  f.npmInstall(signal => new Promise((_resolve, reject) => {
    began(); signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
  }));
  const preparation = f.updater.prepare();
  const failed = assert.rejects(preparation, /cancelled/);
  await started; await f.updater.cancel(); await failed;
  assert.equal(f.manager.tools.length, 1);
  assert.equal(JSON.parse(await readFile(join(f.root, "pi-web/update-transaction.json"), "utf8")).phase, "cancelled");
  await assert.rejects(readFile(join(f.root, "pi-web/update.json")), { code: "ENOENT" });
  await f.manager.manage(hostedId, "disable"); await f.manager.manage(hostedId, "enable");
});

test("rejected view drain retains current runtime, releases management and permits selecting alpha", async t => {
  const f = await setup(t), prepared = await f.updater.prepare();
  f.failDrain();
  await assert.rejects(f.updater.requestRestart(prepared), /Close editors/);
  assert.equal(f.manager.tools.length, 1);
  await f.manager.manage(hostedId, "disable");
  await f.manager.manage(hostedId, "enable");
  await f.updater.setChannel("alpha");
  const next = await f.updater.prepare({ channel: "alpha", version: "0.1.38-alpha.1" });
  assert.equal(next.version, "0.1.38-alpha.1");
  await assert.rejects(readFile(join(f.root, "pi-web/launcher.restart")), { code: "ENOENT" });
  await assert.rejects(readFile(join(f.root, "pi-web/update.json")), { code: "ENOENT" });
});

test("a second live updater cannot cancel another launcher's accepted handoff", async t => {
  const root = await mkdtemp(join(tmpdir(), "update-live-owner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const current = join(root, "current"), state = join(root, "pi-web");
  await mkdir(current); await mkdir(state);
  await writeFile(join(current, "package.json"), JSON.stringify({ name: "pi-webapp", version: "0.1.36" }));
  const before = Buffer.from(JSON.stringify({ version: "0.1.36", launcher: join(current, "bin/pi-webapp.mjs") }));
  const selected = Buffer.from(JSON.stringify({ version: "0.1.37", launcher: join(root, "next/bin/pi-webapp.mjs") }));
  const selectionPath = join(state, "update.json");
  await writeFile(selectionPath, selected);
  await writeFile(join(state, "launcher.json"), JSON.stringify({ nonce: "owner-A", pid: process.pid,
    piPid: process.pid, version: "0.1.36" }));
  await writeFile(join(state, "launcher.restart"), JSON.stringify({ nonce: "owner-A", launcher: join(root, "next/bin/pi-webapp.mjs") }));
  await writeFile(join(state, "update-transaction.json"), JSON.stringify({ schema: 1,
    id: "11111111-1111-4111-8111-111111111111", phase: "restart-requested", version: "0.1.37", channel: "stable",
    packageRoot: join(root, "next"), ownerNonce: "owner-A", selectionPath,
    before: before.toString("base64"), selectedDigest: fingerprint(selected.toString("base64")) }));
  const ownerA = new SelfUpdater({ agentDir: root, packageRoot: current, launcherNonce: "owner-A" });
  const ownerB = new SelfUpdater({ agentDir: root, packageRoot: current, launcherNonce: "owner-B" });
  await assert.rejects(ownerA.cancel(), /启动器|handoff|owner|receipt/i);
  await assert.rejects(ownerB.cancel(), /启动器|handoff|owner|receipt|回退|选择|收据/i);
  assert.deepEqual(await readFile(selectionPath), selected, "a live owner's exact selected bytes remain unchanged");
  assert.equal(JSON.parse(await readFile(join(state, "update-transaction.json"), "utf8")).phase, "restart-requested");
  await writeFile(selectionPath, before);
  await assert.rejects(ownerB.cancel(), /启动器|归属|回退|收据/i, "rollback bytes alone do not authorize a different live instance");
  await rm(join(state, "launcher.restart")); // Simulate actual launcher consumption before fallback.
  await writeFile(join(state, "launcher.json"), JSON.stringify({ nonce: "owner-B", pid: process.pid,
    piPid: process.pid, version: "0.1.36" }));
  await ownerB.cancel();
  assert.deepEqual(await readFile(selectionPath), before);
  assert.equal(JSON.parse(await readFile(join(state, "update-transaction.json"), "utf8")).phase, "cancelled");
});
