import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import { HostedPluginManager } from "../src/host/server/plugins/hosted/manager.ts";
import { HostedPluginInstaller } from "../src/host/server/plugins/hosted/installer.ts";
import { HostedPluginIntegration } from "../src/host/server/plugins/hosted/integration.ts";
import { HostedStateBroker } from "../src/host/server/plugins/hosted/state-broker.ts";
import { atomicJson, withStorageLock } from "../src/host/server/plugins/hosted/storage.ts";
import { candidateHost, fingerprint, pairRoot, pairTransaction, readPair } from "../src/host/server/updates/hosted-pair.ts";
import { SelfUpdater } from "../src/host/server/updates/self-update.ts";
import { hostedId as id, integrationFixture, integrity } from "./helpers/hosted-integration-fixture.ts";

const hooks = () => ({ canSwitch: () => true, freeze: async () => {}, resume: async () => {}, committed: async () => {} });
const contract = { protocol: 2, runtimeProtocol: 1, pairJournal: 1, capabilities: ["state", "workspace", "legacy", "panels", "messages"] };
async function host(root: string, version: string, worker: Buffer) {
  await Promise.all(["dist", "bin", "web/dist"].map(p => mkdir(join(root, p), { recursive: true })));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "pi-webapp", version, piWebappDesktopProtocol: 1, piWebappHostedRuntime: contract }));
  await writeFile(join(root, "dist/hosted-worker.js"), worker);
  await writeFile(join(root, "dist/extension.js"), "// synthetic host: never executed");
  await writeFile(join(root, "bin/pi-webapp.mjs"), "// synthetic launcher: never executed");
  await writeFile(join(root, "web/dist/index.html"), "synthetic host");
}
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "ori38-pair-")), storage = join(root, "hosted"), workerEntry = join(root, "worker.mjs");
  await build({ entryPoints: [new URL("../src/host/server/plugins/hosted/worker-entry.ts", import.meta.url).pathname], outfile: workerEntry, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  const worker = await readFile(workerEntry), oldHost = join(root, "old"), nextHost = join(root, "next");
  await host(oldHost, "0.1.29", worker); await host(nextHost, "0.2.0", worker);
  const old = integrationFixture("0.1.0", false, ">=0.1.0 <0.2.0"), next = integrationFixture("0.2.0", false, ">=0.2.0 <1.0.0");
  let offline = false, downloads = 0, registry = 0;
  const options = { root: storage, workerEntry, hooks, fetch: (async url => {
    if (offline) throw new Error("offline");
    if (String(url).endsWith(".tgz")) { downloads++; return new Response(new Uint8Array(next.bytes)); }
    registry++; return Response.json({ versions: { "0.2.0": next.release } });
  }) as typeof fetch };
  let manager = new HostedPluginManager({ ...options, packageRoot: oldHost, hostVersion: "0.1.29" });
  t.after(async () => { await manager.shutdown(); await rm(root, { recursive: true, force: true }); });
  return { root, storage, worker, workerEntry, oldHost, nextHost, old, next, options, get manager() { return manager; },
    restart: async (version = "0.2.0") => { await manager.shutdown(); manager = new HostedPluginManager({ ...options, packageRoot: version === "0.1.29" ? oldHost : nextHost, hostVersion: version }); await manager.start(); return manager; },
    offline: () => { offline = true; }, calls: () => ({ downloads, registry }) };
}

test("npm and desktop business-package updater stage required pair, keep old runtime until restart and reconcile offline", async t => {
  for (const desktopManaged of [false, true]) await t.test(desktopManaged ? "desktop" : "npm", async t => {
    const f = await fixture(t);
    await f.manager.installer.installArchive(id, f.old.bytes, integrity(f.old.bytes), "0.1.0");
    await f.manager.manage(id, "enable");
    const generation = f.manager.tools[0]!.generation;
    const updater = new SelfUpdater({ agentDir: f.root, packageRoot: f.oldHost, launcherNonce: "nonce", hostedPair: f.manager.hostPair,
      desktopManaged, desktopPackageUpdates: true, peerSpecs: async () => [], verifyPackage: async () => {},
      runNpm: async args => {
        if (args[0] === "view") return JSON.stringify("0.2.0");
        assert.ok(args.includes("--ignore-scripts"));
        const prefix = args[args.indexOf("--prefix") + 1]!;
        await host(join(prefix, "node_modules/pi-webapp"), "0.2.0", f.worker);
        if (desktopManaged) {
          const pi = join(prefix, "node_modules/@earendil-works/pi-coding-agent");
          await mkdir(join(pi, "dist/bundle"), { recursive: true });
          await writeFile(join(pi, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.3.0" }));
          await writeFile(join(pi, "dist/bundle/cli.js"), "// synthetic dependency; never executed");
        }
        return "";
      } });
    const prepared = await updater.prepare();
    assert.deepEqual(f.calls(), { downloads: 1, registry: 1 });
    assert.equal(f.manager.tools[0]!.generation, generation);
    assert.equal((await f.manager.inventory()).plugins[0]!.activeVersion, "0.1.0");
    assert.equal((await readPair(f.storage))!.phase, "selected");
    await assert.rejects(f.manager.manage(id, "disable"), /selection pending/);
    await assert.rejects(f.manager.setPolicy(id, { updatePolicy: "pinned", pinnedVersion: "0.1.0" }), /selection pending/);
    await updater.requestRestart(prepared);
    assert.equal(JSON.parse(await readFile(join(f.root, "pi-web/launcher.restart"), "utf8")).launcher, prepared.launcher);
    const pointerPath = join(f.root, "pi-web", desktopManaged ? "desktop-update.json" : "update.json");
    const pointerBytes = await readFile(pointerPath);
    const pointer = JSON.parse(pointerBytes.toString("utf8"));
    assert.equal(pointer.version, "0.2.0");
    await writeFile(pointerPath, JSON.stringify({ ...pointer, version: "0.9.0" }));
    await assert.rejects(updater.requestRestart(prepared), /pointer changed/);
    await writeFile(pointerPath, pointerBytes);
    f.offline(); const manager = await f.restart();
    assert.equal((await manager.inventory()).plugins[0]!.activeVersion, "0.2.0");
    assert.equal(manager.tools.length, 1); assert.equal((await readPair(f.storage))!.phase, "reconciled");
    assert.deepEqual(f.calls(), { downloads: 1, registry: 1 });
    await f.restart(); assert.equal((await f.manager.inventory()).plugins[0]!.activeVersion, "0.2.0");
  });
});

test("production integration consumes controlled combination offline without a second registry selection", async t => {
  const f = await fixture(t);
  await f.manager.installer.installArchive(id, f.old.bytes, integrity(f.old.bytes), "0.1.0"); await f.manager.manage(id, "enable");
  await f.manager.hostPair.select("0.2.0", f.nextHost, async () => {}); await f.manager.shutdown(); f.offline();
  const integration = new HostedPluginIntegration({ ...f.options, packageRoot: f.nextHost, hostVersion: "0.2.0", ownerId: "local", resolveSession: () => null });
  try {
    await integration.start();
    assert.equal(integration.manager.tools.length, 1);
    assert.equal((await integration.inventory()).plugins[0]!.version, "0.2.0");
    assert.equal(JSON.parse(await readFile(join(f.storage, "host-version.json"), "utf8")).version, "0.2.0");
    assert.equal((await readPair(f.storage))!.phase, "reconciled");
    assert.deepEqual(f.calls(), { downloads: 1, registry: 1 });
  } finally { await integration.shutdown(); }
});

test("required upgrade offline failure writes no host pointer; old combination remains usable", async t => {
  const f = await fixture(t); await f.manager.installer.installArchive(id, f.old.bytes, integrity(f.old.bytes), "0.1.0"); await f.manager.manage(id, "enable");
  const before = await f.manager.pairSnapshot(); f.offline(); let writes = 0;
  await assert.rejects(f.manager.hostPair.select("0.2.0", f.nextHost, async () => { writes++; }), /offline/);
  assert.equal(writes, 0); assert.equal(await readPair(f.storage), null);
  assert.deepEqual(await f.manager.pairSnapshot(), before);
  await f.restart("0.1.29"); assert.equal(f.manager.tools.length, 1);
});

test("absent never downloads; disabled stays disabled; pinned incompatibility blocks; no downgrade", async t => {
  const absent = await fixture(t); absent.offline(); await absent.manager.hostPair.select("0.2.0", absent.nextHost, async () => {});
  assert.deepEqual((await readPair(absent.storage))!.selections, []); assert.deepEqual(absent.calls(), { downloads: 0, registry: 0 });
  const disabled = await fixture(t); await disabled.manager.installer.installArchive(id, disabled.old.bytes, integrity(disabled.old.bytes), "0.1.0");
  await disabled.manager.hostPair.select("0.2.0", disabled.nextHost, async () => {}); await disabled.restart();
  assert.equal((await disabled.manager.inventory()).plugins[0]!.enabled, false); assert.equal(disabled.manager.tools.length, 0);
  const pinned = await fixture(t); await pinned.manager.installer.installArchive(id, pinned.old.bytes, integrity(pinned.old.bytes), "0.1.0");
  await pinned.manager.setPolicy(id, { updatePolicy: "pinned", pinnedVersion: "0.1.0" });
  await assert.rejects(pinned.manager.hostPair.select("0.2.0", pinned.nextHost, async () => assert.fail("pointer")), /incompatible/);
  assert.deepEqual(pinned.calls(), { downloads: 0, registry: 0 });
  const newer = integrationFixture("0.3.0", false, ">=0.1.0 <0.2.0");
  const downgrade = await fixture(t); await downgrade.manager.installer.installArchive(id, newer.bytes, integrity(newer.bytes), "0.3.0");
  await assert.rejects(downgrade.manager.hostPair.select("0.2.0", downgrade.nextHost, async () => assert.fail("pointer")), /No compatible/);
});

test("metadata, preflight drift, restart drift and cross-process owner reject before writes", async t => {
  const f = await fixture(t); await writeFile(join(f.nextHost, "package.json"), JSON.stringify({ name: "pi-webapp", version: "0.2.0" }));
  await assert.rejects(candidateHost("0.2.0", f.nextHost), /explicit hosted/);
  await host(f.nextHost, "0.2.0", f.worker);
  let state = 1;
  const pair = pairTransaction(f.storage, async () => { state++; return []; }, async () => state);
  await assert.rejects(pair.select("0.2.0", f.nextHost, async () => assert.fail("pointer")), /changed during preflight/);
  await withStorageLock(pairRoot(f.storage), async () => {
    const storageUrl = new URL("../src/host/server/plugins/hosted/storage.ts", import.meta.url).href;
    const script = `const {withStorageLock}=await import(${JSON.stringify(storageUrl)}); try {await withStorageLock(process.argv[1],async()=>{},50);process.exit(2)} catch(e){if(e.code!=="storage_busy")throw e}`;
    await promisify(execFile)(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, pairRoot(f.storage)], { timeout: 15000 });
  });
  const stable = pairTransaction(f.storage, async () => [], async () => state);
  await stable.select("0.2.0", f.nextHost, async () => {}); state++;
  await assert.rejects(stable.restart("0.2.0", f.nextHost, async () => assert.fail("restart")), /changed/);
  state--; await writeFile(join(f.nextHost, "dist/hosted-worker.js"), "tampered");
  await assert.rejects(stable.restart("0.2.0", f.nextHost, async () => assert.fail("restart")), /changed/);
  await writeFile(join(f.nextHost, "dist/hosted-worker.js"), f.worker);
  await writeFile(join(f.nextHost, "bin/pi-webapp.mjs"), "// changed launcher; never executed");
  await assert.rejects(stable.restart("0.2.0", f.nextHost, async () => assert.fail("restart")), /changed/);
});

test("pointer faults before/after commit retain explanatory journal; old and selected startup recover without rollback", async t => {
  for (const after of [false, true]) await t.test(after ? "after pointer" : "before pointer", async t => {
    const f = await fixture(t); await f.manager.installer.installArchive(id, f.old.bytes, integrity(f.old.bytes), "0.1.0"); await f.manager.manage(id, "enable");
    const pointer = join(f.root, "selection.json");
    await assert.rejects(f.manager.hostPair.select("0.2.0", f.nextHost, async () => {
      if (after) await atomicJson(pointer, { version: "0.2.0" }); throw new Error("injected pointer crash");
    }), /injected/);
    assert.equal((await readPair(f.storage))!.phase, "selecting");
    if (!after) {
      await assert.rejects(readFile(pointer), { code: "ENOENT" });
      await f.restart("0.1.29"); assert.equal(f.manager.tools.length, 1);
      assert.match((await f.manager.inventory()).plugins[0]!.error!.message, /Required action/);
    }
    f.offline(); await f.restart();
    if (after) {
      assert.equal((await f.manager.inventory()).plugins[0]!.activeVersion, "0.2.0");
      assert.equal((await readPair(f.storage))!.phase, "reconciled");
    } else {
      // The old-host startup accepted a newer generation. A stale plan must not replace it.
      assert.equal((await f.manager.inventory()).plugins[0]!.activeVersion, "0.1.0");
      assert.equal((await readPair(f.storage))!.phase, "required-action");
    }
  });
});

test("hard process exit preserves intent and refuses abandoned-owner takeover; stopped-owner recovery admits selected pair", async t => {
  const f = await fixture(t);
  await f.manager.installer.installArchive(id, f.old.bytes, integrity(f.old.bytes), "0.1.0"); await f.manager.manage(id, "enable");
  const target = new HostedPluginInstaller({ root: f.manager.installer.root, hostVersion: "0.2.0" });
  await target.installArchive(id, f.next.bytes, integrity(f.next.bytes), "0.2.0");
  await f.manager.shutdown(); // No live runtime owner remains before the child starts.
  const moduleUrl = new URL("../src/host/server/plugins/hosted/manager.ts", import.meta.url).href;
  const script = `const {HostedPluginManager}=await import(${JSON.stringify(moduleUrl)});
    const manager=new HostedPluginManager({root:process.argv[1],hostVersion:"0.1.29",workerEntry:process.argv[2],hooks:()=>({}),fetch:async()=>{throw new Error("offline")}});
    await manager.hostPair.select("0.2.0",process.argv[3],async()=>{process.exit(0)});process.exit(2);`;
  await promisify(execFile)(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, f.storage, f.workerEntry, f.nextHost], { timeout: 15000 });
  const before = await readFile(join(pairRoot(f.storage), "intent.json"));
  assert.equal((await readPair(f.storage))!.phase, "selecting");
  await assert.rejects(f.restart(), /locked; stop all writers/);
  assert.deepEqual(await readFile(join(pairRoot(f.storage), "intent.json")), before);
  // Test-only operator recovery: child exit was observed and every other owner was stopped.
  // Production never guesses staleness from a PID or steals another process's lock.
  await rm(join(pairRoot(f.storage), "transaction.lock"));
  f.offline(); await f.restart();
  assert.equal((await f.manager.inventory()).plugins[0]!.activeVersion, "0.2.0");
  assert.equal((await readPair(f.storage))!.phase, "reconciled");
});

test("startup never replays pair over newer confirmed disable/state generation", async t => {
  const f = await fixture(t); await f.manager.installer.installArchive(id, f.old.bytes, integrity(f.old.bytes), "0.1.0"); await f.manager.manage(id, "enable");
  await f.manager.hostPair.select("0.2.0", f.nextHost, async () => {});
  const broker = new HostedStateBroker(join(f.storage, "data"), id), before = (await broker.active())!;
  const newer = await broker.activate(before.generation, { ...before, enabled: false });
  await f.restart(); assert.deepEqual(await broker.active(), newer); assert.equal(f.manager.tools.length, 0);
  assert.equal((await readPair(f.storage))!.phase, "reconciled");
});

test("pinned real external archive and built worker across two synthetic host package versions; native incompatible runtime is refused with data retained", { skip: !process.env.ORI38_EXCALIDRAW_TGZ }, async t => {
  const f = await fixture(t), bytes = await readFile(process.env.ORI38_EXCALIDRAW_TGZ!);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), process.env.ORI38_EXCALIDRAW_SHA256 ?? "0036300e1647f0b79a2f565514645859639725ab0d167de005f32ca7988e9d97");
  await f.manager.installer.installArchive(id, bytes, integrity(bytes), "0.1.0"); await f.manager.manage(id, "enable"); f.offline();
  await f.manager.hostPair.select("0.2.0", f.nextHost, async () => {}); await f.restart();
  assert.equal(f.manager.tools[0]!.descriptors.length, 6); assert.equal((await readPair(f.storage))!.phase, "reconciled");
  const broker = new HostedStateBroker(join(f.storage, "data"), id), before = await broker.active();
  await f.manager.setPolicy(id, { updatePolicy: "pinned", pinnedVersion: "0.1.0" });
  // Manual native-shell replacement is not an OS installer transaction.
  await f.restart("0.0.1"); assert.equal(f.manager.tools.length, 0);
  assert.deepEqual(await broker.active(), before);
  assert.match((await f.manager.inventory()).plugins[0]!.error!.message, /Required action.*data retained/);
  assert.equal(fingerprint(await broker.active()), fingerprint(before));
});
