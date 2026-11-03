import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import { HostedPluginManager } from "../src/host/server/plugins/hosted/manager.ts";
import { ServerPluginRegistry } from "../src/host/server/plugins/registry.ts";
import { SelfUpdater } from "../src/host/server/updates/self-update.ts";
import { pairRoot, readPair } from "../src/host/server/updates/hosted-pair.ts";
import { integrationFixture, hostedId, integrity } from "./helpers/hosted-integration-fixture.ts";
import type { ServerPlugin } from "../src/host/server/plugins/server-plugin.ts";

async function managerWithStuckView(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "update-never-blocked-")), worker = join(root, "worker.js"), packageRoot = join(root, "current");
  await build({ entryPoints: [new URL("../src/host/server/plugins/hosted/worker-entry.ts", import.meta.url).pathname], outfile: worker, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  await Promise.all(["dist", "bin"].map(dir => mkdir(join(packageRoot, dir), { recursive: true })));
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "pi-webapp", version: "0.1.36", piWebappHostedRuntime: { protocol: 2, runtimeProtocol: 1, pairJournal: 1, ownershipProtocol: 2, capabilities: ["state", "workspace", "legacy", "panels", "messages"] } }));
  await writeFile(join(packageRoot, "dist/hosted-worker.js"), await readFile(worker));
  const archive = integrationFixture("0.1.0", false, ">=0.1.0 <1.0.0");
  let stuck = false;
  const viewBarrier = () => Object.assign(new Error("Missing view flush acknowledgement"), { code: "view_barrier" });
  const manager = new HostedPluginManager({ root: join(root, "hosted"), workerEntry: worker, hostVersion: "0.1.36", packageRoot,
    hooks: () => ({ canSwitch: () => true, freeze: async () => { if (stuck) throw viewBarrier(); }, resume: async () => {}, committed: async () => {} }),
    fetch: (async () => Response.json({ versions: { "0.1.0": archive.release } })) as typeof fetch });
  t.after(async () => { stuck = false; await manager.shutdown(); await rm(root, { recursive: true, force: true }); });
  await manager.installer.installArchive(hostedId, archive.bytes, integrity(archive.bytes), "0.1.0");
  await manager.manage(hostedId, "enable");
  stuck = true;
  return { root, manager };
}

test("an unconfirmed plugin view needs confirmation, never refuses a confirmed update restart", async t => {
  const { manager } = await managerWithStuckView(t);
  await assert.rejects(manager.suspendForRestart(), { code: "view_barrier" });
  assert.equal(manager.tools.length, 1, "unconfirmed: the plugin keeps running");
  const resume = await manager.suspendForRestart(true);
  assert.equal(manager.tools.length, 0, "confirmed: the worker stops and the restart proceeds");
  await resume(); assert.equal(manager.tools.length, 1, "a failed restart still gets the plugin back");
});

test("corrupt pair and update journals are quarantined with bytes retained, never brick the updater", async t => {
  const root = await mkdtemp(join(tmpdir(), "update-quarantine-")); t.after(() => rm(root, { recursive: true, force: true }));
  const storage = join(root, "hosted"); await mkdir(pairRoot(storage), { recursive: true });
  await writeFile(join(pairRoot(storage), "intent.json"), "{not json");
  assert.equal(await readPair(storage), null);
  assert.deepEqual((await readdir(pairRoot(storage))).filter(name => name.startsWith("intent.json.corrupt-")).length, 1);

  const packageRoot = join(root, "current"); await mkdir(join(root, "pi-web"), { recursive: true }); await mkdir(packageRoot);
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "pi-webapp", version: "0.1.36" }));
  await writeFile(join(root, "pi-web/update-transaction.json"), JSON.stringify({ schema: 9, phase: "mystery" }));
  const updater = new SelfUpdater({ agentDir: root, packageRoot, launcherNonce: "fixture", runNpm: async () => JSON.stringify("0.1.37") });
  const status = await updater.check();
  assert.equal(status.available, true); assert.equal(status.recovery, undefined);
  const retained = (await readdir(join(root, "pi-web"))).find(name => name.startsWith("update-transaction.json.corrupt-"))!;
  assert.deepEqual(JSON.parse(await readFile(join(root, "pi-web", retained), "utf8")), { schema: 9, phase: "mystery" });
});

test("a failed update records its actual cause, not only a generic download failure", async t => {
  const root = await mkdtemp(join(tmpdir(), "update-failure-cause-")); t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = join(root, "current"); await mkdir(packageRoot);
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "pi-webapp", version: "0.1.36" }));
  const updater = new SelfUpdater({ agentDir: root, packageRoot, launcherNonce: "fixture", desktopManaged: false, runNpm: async args => {
    if (args[0] === "view") return JSON.stringify("0.1.37");
    throw new Error("Host pair selection pending (0.1.36, selected): restart selected host");
  } });
  await assert.rejects(updater.prepare(), /Host pair selection pending/);
  const transaction = JSON.parse(await readFile(join(root, "pi-web/update-transaction.json"), "utf8"));
  assert.equal(transaction.phase, "failed");
  assert.match(transaction.message, /下载或验证失败：Host pair selection pending \(0\.1\.36, selected\)/);
});

test("open terminals are a confirmation, released only after the user confirms", async () => {
  let open = 2, released = 0;
  const terminal = { metadata: { id: "terminal" }, routes: [], handle: async () => {},
    restartBlocker: () => open ? `有 ${open} 个终端正在运行，升级会关闭它们` : null,
    releaseForRestart: async () => { released++; open = 0; } } as unknown as ServerPlugin;
  const registry = new ServerPluginRegistry([terminal], { enabled: () => true } as never);
  assert.equal(registry.restartBlocker(), null, "terminals are never a hard block");
  assert.deepEqual(registry.restartConfirmations(), ["有 2 个终端正在运行，升级会关闭它们"]);
  await registry.releaseForRestart();
  assert.equal(released, 1); assert.deepEqual(registry.restartConfirmations(), []);
});
