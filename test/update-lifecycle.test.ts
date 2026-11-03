import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import { HostedPluginManager } from "../src/host/server/plugins/hosted/manager.ts";
import { SelfUpdater } from "../src/host/server/updates/self-update.ts";
import { readPair } from "../src/host/server/updates/hosted-pair.ts";
import { readCandidate, recordUpgradeTransaction, upgradeRoot } from "../bin/upgrade-transaction.mjs";
import { integrationFixture, hostedId, integrity } from "./helpers/hosted-integration-fixture.ts";

// Real manager, worker, storage and updater; only the public registry/npm transport is a fixture.
// The host side of an update ends at a candidate plus a restart request; the launcher owns the rest.
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
  const updater = new SelfUpdater({ agentDir: root, packageRoot, launcherNonce: "fixture",
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
  return { root, storage, packageRoot, host, updater, manager, get suspended() { return suspended; }, failDrain: () => { failDrain = true; },
    npmInstall: (next: (signal?: AbortSignal) => Promise<void>) => { npmInstall = next; } };
}

const transactionOf = async (root: string) => JSON.parse(await readFile(join(root, "pi-web/update-transaction.json"), "utf8"));
const history = async (root: string) => Promise.all((await readdir(join(root, "pi-web/update-history"))).map(async name => JSON.parse(await readFile(join(root, "pi-web/update-history", name), "utf8"))));

test("download and prepare write only a candidate: no pointer, no host-pair journal, plugins keep their lifecycle", async t => {
  const f = await setup(t);
  const prepared = await f.updater.prepare();
  await assert.rejects(readFile(join(f.root, "pi-web/update.json")), { code: "ENOENT" });
  assert.equal(await readPair(f.storage), null);
  const candidate = (await readCandidate(f.root))!;
  assert.equal(candidate.version, "0.1.37"); assert.equal(candidate.launcher, prepared.launcher); assert.equal(candidate.schema, 1);
  assert.equal((await transactionOf(f.root)).phase, "prepared");
  await f.manager.manage(hostedId, "disable");
  await f.manager.manage(hostedId, "enable");
  assert.equal(f.manager.tools.length, 1);
});

test("the restart request names the candidate after the drain and is durable before the launcher acts", async t => {
  const f = await setup(t), prepared = await f.updater.prepare(), candidate = (await readCandidate(f.root))!;
  await f.updater.requestRestart(prepared);
  assert.equal(f.suspended, true, "plugins were drained before the request");
  assert.deepEqual(JSON.parse(await readFile(join(f.root, "pi-web/launcher.restart"), "utf8")), { nonce: "fixture", candidate: candidate.id });
  assert.equal((await transactionOf(f.root)).phase, "restart-requested");
  await assert.rejects(readFile(join(f.root, "pi-web/update.json")), { code: "ENOENT" }, "the launcher, not the host, selects");
  await assert.rejects(f.updater.cancel(), /启动器/, "once handed to the launcher, the launcher owns the outcome");
});

test("a stale restart marker from another launcher is moved aside, never a permanent fence", async t => {
  const f = await setup(t), prepared = await f.updater.prepare();
  await writeFile(join(f.root, "pi-web/launcher.restart"), JSON.stringify({ nonce: "dead-launcher", launcher: "/gone" }));
  await f.updater.requestRestart(prepared);
  assert.equal(JSON.parse(await readFile(join(f.root, "pi-web/launcher.restart"), "utf8")).nonce, "fixture");
  const kept = await readdir(join(f.root, "pi-web/restart-history"));
  assert.equal(kept.length, 1); assert.equal(JSON.parse(await readFile(join(f.root, "pi-web/restart-history", kept[0]!), "utf8")).nonce, "dead-launcher");
});

test("after a restart the running version commits its own update; a rollback is recorded with the launcher's real cause", async t => {
  const f = await setup(t), prepared = await f.updater.prepare(), candidate = (await readCandidate(f.root))!;
  await f.updater.requestRestart(prepared);
  // The launcher could not start 0.1.37 and restarted this version: a fresh host process sees the outcome.
  await recordUpgradeTransaction(f.root, { id: candidate.id, phase: "rolled-back", version: "0.1.37", from: "0.1.36", message: "Version 0.1.37 failed to start (launcher exit code 3); previous version restored" });
  const fresh = new SelfUpdater({ agentDir: f.root, packageRoot: f.packageRoot, launcherNonce: "after-rollback", runNpm: async () => JSON.stringify("0.1.37") });
  const status = await fresh.check();
  assert.equal(status.recovery, undefined); assert.equal(status.available, true);
  assert.match(status.lastFailure!.message, /failed to start \(launcher exit code 3\)/);
  const failed = (await history(f.root)).find(record => record.id === candidate.id && record.phase === "failed");
  assert.match(failed.message, /launcher exit code 3/, "the history record keeps the real cause");
  // The selected version running commits instead.
  await f.host(join(f.root, "next"), "0.1.37");
  await writeFile(join(f.root, "pi-web/update-transaction.json"), JSON.stringify({ ...await transactionOf(f.root), phase: "restart-requested" }));
  await new SelfUpdater({ agentDir: f.root, packageRoot: join(f.root, "next"), launcherNonce: "next" }).runningVersion();
  assert.equal((await transactionOf(f.root)).phase, "committed");
});

test("records left by earlier versions or interrupted runs never fence the next update", async t => {
  for (const phase of ["downloading", "validating", "prepared", "selecting", "selected", "restart-requested"]) {
    const f = await setup(t);
    await mkdir(join(f.root, "pi-web"), { recursive: true });
    await writeFile(join(f.root, "pi-web/update-transaction.json"), JSON.stringify({ schema: 1, id: "11111111-1111-4111-8111-111111111111", phase,
      version: "0.1.99", channel: "stable", selectionPath: join(f.root, "pi-web/update.json"), ownerNonce: "gone",
      before: null, selectedDigest: "a".repeat(64) }));
    const prepared = await f.updater.prepare();
    assert.equal(prepared.version, "0.1.37", phase);
    assert.equal((await history(f.root)).find(record => record.id === "11111111-1111-4111-8111-111111111111")?.phase, "failed", phase);
  }
});

test("an expired or corrupt candidate is quarantined; the update refuses clearly and a fresh download proceeds", async t => {
  const f = await setup(t), prepared = await f.updater.prepare();
  const path = join(upgradeRoot(f.root), "candidate.json");
  await writeFile(path, JSON.stringify({ ...JSON.parse(await readFile(path, "utf8")), createdAt: new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString() }));
  await assert.rejects(f.updater.requestRestart(prepared), /过期/);
  assert.ok((await readdir(upgradeRoot(f.root))).some(name => name.startsWith("candidate.json.expired-")), "expired bytes are kept aside");
  await f.updater.cancel();
  await writeFile(path, "{not json");
  assert.equal(await readCandidate(f.root), null);
  assert.ok((await readdir(upgradeRoot(f.root))).some(name => name.startsWith("candidate.json.invalid-")));
  const again = await f.updater.prepare();
  await f.updater.requestRestart(again);
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

test("rejected view drain retains current runtime and the candidate, releases management and permits selecting alpha", async t => {
  const f = await setup(t), prepared = await f.updater.prepare(), candidate = (await readCandidate(f.root))!;
  f.failDrain();
  await assert.rejects(f.updater.requestRestart(prepared), /Close editors/);
  assert.equal(f.manager.tools.length, 1);
  assert.equal((await transactionOf(f.root)).phase, "prepared");
  assert.equal((await readCandidate(f.root))?.id, candidate.id);
  await f.manager.manage(hostedId, "disable");
  await f.manager.manage(hostedId, "enable");
  await f.updater.setChannel("alpha");
  assert.equal((await readCandidate(f.root)), null, "switching channel retires the old candidate");
  assert.ok((await readdir(join(upgradeRoot(f.root), "history"))).includes(`${candidate.id}-candidate-cancelled.json`));
  const next = await f.updater.prepare({ channel: "alpha", version: "0.1.38-alpha.1" });
  assert.equal(next.version, "0.1.38-alpha.1");
  await assert.rejects(readFile(join(f.root, "pi-web/launcher.restart")), { code: "ENOENT" });
  await assert.rejects(readFile(join(f.root, "pi-web/update.json")), { code: "ENOENT" });
});
