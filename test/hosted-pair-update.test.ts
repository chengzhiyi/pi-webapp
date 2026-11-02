import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import { HostedPluginManager } from "../src/host/server/plugins/hosted/manager.ts";
import { HostedPluginInstaller } from "../src/host/server/plugins/hosted/installer.ts";
import { HostedPluginIntegration } from "../src/host/server/plugins/hosted/integration.ts";
import { HostedStateBroker } from "../src/host/server/plugins/hosted/state-broker.ts";
import { atomicJson, withStorageLock } from "../src/host/server/plugins/hosted/storage.ts";
import { activePair, candidateHost, fingerprint, PAIR_STALE_MS, pairRoot, pairTransaction, readPair, writePair } from "../src/host/server/updates/hosted-pair.ts";
import { inspectStoppedStorage, settleStoppedPair, STOPPED_CONFIRMATION } from "../src/host/server/plugins/hosted/stopped-recovery.ts";
import { SelfUpdater } from "../src/host/server/updates/self-update.ts";
import { hostedId as id, integrationFixture, integrity } from "./helpers/hosted-integration-fixture.ts";

const hooks = () => ({ canSwitch: () => true, freeze: async () => {}, resume: async () => {}, committed: async () => {} });
const contract = { protocol: 2, runtimeProtocol: 1, pairJournal: 1, ownershipProtocol: 2, capabilities: ["state", "workspace", "legacy", "panels", "messages"] };
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
    offline: () => { offline = true; }, online: () => { offline = false; }, calls: () => ({ downloads, registry }) };
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
    assert.equal((await readPair(f.storage))!.phase, "prepared");
    await f.manager.setPolicy(id, { updatePolicy: "notify" });
    await updater.requestRestart(prepared);
    assert.equal(JSON.parse(await readFile(join(f.root, "pi-web/launcher.restart"), "utf8")).launcher, prepared.launcher);
    const pointerPath = join(f.root, "pi-web", desktopManaged ? "desktop-update.json" : "update.json");
    const pointerBytes = await readFile(pointerPath);
    const pointer = JSON.parse(pointerBytes.toString("utf8"));
    assert.equal(pointer.version, "0.2.0");
    await writeFile(pointerPath, JSON.stringify({ ...pointer, version: "0.9.0" }));
    await assert.rejects(f.manager.hostPair.restart(prepared.version, join(prepared.launcher, "../.."), async () => assert.fail("tampered selection must not restart")), /changed/);
    await writeFile(pointerPath, pointerBytes);
    f.offline(); const manager = await f.restart();
    assert.equal((await manager.inventory()).plugins[0]!.activeVersion, "0.2.0");
    assert.equal(manager.tools.length, 1); assert.equal((await readPair(f.storage))!.phase, "reconciled");
    // A plugin policy change between staging and selection no longer forces a second registry preflight.
    assert.deepEqual(f.calls(), { downloads: 1, registry: 1 });
    await f.restart(); assert.equal((await f.manager.inventory()).plugins[0]!.activeVersion, "0.2.0");
  });
});

test("paired software update retains compatible independent plugin without consulting registry", async t => {
  const f = await fixture(t), compatible = integrationFixture("0.1.0", false, ">=0.1.0 <1.0.0");
  await f.manager.installer.installArchive(id, compatible.bytes, integrity(compatible.bytes), "0.1.0");
  await f.manager.hostPair.select("0.2.0", f.nextHost, async () => {});
  assert.deepEqual((await readPair(f.storage))!.selections, [], "plugins are never staged with the host");
  assert.deepEqual(f.calls(), { downloads: 0, registry: 0 });
  await f.restart();
  assert.equal((await f.manager.inventory()).plugins[0]!.version, "0.1.0");
  assert.equal((await f.manager.inventory()).plugins[0]!.enabled, false);
});

test("alpha host pair preserves exact preview identity and enabled stable plugin across offline restart", async t => {
  const f = await fixture(t), version = "0.1.31-alpha.5";
  const compatible = integrationFixture("0.1.0", false, ">=0.1.0 <1.0.0");
  await host(f.nextHost, version, f.worker);
  await f.manager.installer.installArchive(id, compatible.bytes, integrity(compatible.bytes), "0.1.0");
  await f.manager.manage(id, "enable");
  f.offline();
  await f.manager.hostPair.select(version, f.nextHost, async () => {});
  assert.equal((await readPair(f.storage))!.version, version);
  await f.restart(version);
  const card = (await f.manager.inventory()).plugins[0]!;
  assert.equal(card.enabled, true); assert.equal(card.activeVersion, "0.1.0");
  assert.equal(f.manager.installer.hostVersion, version);
  assert.equal((await readPair(f.storage))!.phase, "reconciled");
  assert.equal(f.manager.tools.length, 1);
});

test("paired software update offline retains compatible code without a spurious network diagnostic", async t => {
  const f = await fixture(t), compatible = integrationFixture("0.1.0", false, ">=0.1.0 <1.0.0");
  await f.manager.installer.installArchive(id, compatible.bytes, integrity(compatible.bytes), "0.1.0");
  f.offline(); await f.manager.hostPair.select("0.2.0", f.nextHost, async () => {});
  assert.deepEqual((await readPair(f.storage))!.selections, [], "plugins are never staged with the host");
  assert.equal((await f.manager.inventory()).plugins[0]!.updateDiagnostic, undefined);
  await f.restart();
  assert.equal((await f.manager.inventory()).plugins[0]!.version, "0.1.0");
});

test("compatible pair startup stays independent of online plugin update availability", async t => {
  const f = await fixture(t), compatible = integrationFixture("0.1.0", false, ">=0.1.0 <1.0.0");
  await f.manager.installer.installArchive(id, compatible.bytes, integrity(compatible.bytes), "0.1.0");
  f.offline(); await f.manager.hostPair.select("0.2.0", f.nextHost, async () => {}); await f.manager.shutdown();
  const options = { ...f.options, packageRoot: f.nextHost, hostVersion: "0.2.0", ownerId: "test", resolveSession: () => null };
  let integration = new HostedPluginIntegration(options);
  await integration.start();
  assert.equal((await integration.inventory()).plugins[0]!.version, "0.1.0");
  assert.equal(JSON.parse(await readFile(join(f.storage, "host-version.json"), "utf8")).version, "0.2.0");
  await integration.shutdown(); f.online();
  integration = new HostedPluginIntegration(options);
  try {
    await integration.start();
    assert.equal((await integration.inventory()).plugins[0]!.version, "0.1.0");
    assert.equal(JSON.parse(await readFile(join(f.storage, "host-version.json"), "utf8")).version, "0.2.0");
  } finally { await integration.shutdown(); }
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

test("an offline incompatible plugin never blocks the host update; it starts unavailable with data retained", async t => {
  const f = await fixture(t); await f.manager.installer.installArchive(id, f.old.bytes, integrity(f.old.bytes), "0.1.0"); await f.manager.manage(id, "enable");
  const before = await f.manager.pairSnapshot(); f.offline(); let writes = 0;
  await f.manager.hostPair.select("0.2.0", f.nextHost, async () => { writes++; });
  assert.equal(writes, 1); assert.deepEqual((await readPair(f.storage))!.selections, []);
  assert.deepEqual(await f.manager.pairSnapshot(), before);
  assert.equal(f.manager.tools.length, 1, "the running plugin keeps working until restart");
  await f.restart();
  const card = (await f.manager.inventory()).plugins[0]!;
  assert.equal(card.activeVersion, "0.1.0"); assert.match(card.error!.message, /Plugin unavailable.*data retained/s);
  assert.equal(f.manager.tools.length, 0); assert.equal((await readPair(f.storage))!.phase, "reconciled");
  await f.restart("0.1.29"); assert.equal(f.manager.tools.length, 1);
});

test("absent never downloads; disabled stays disabled; legacy pin joins pair update; no downgrade", async t => {
  const absent = await fixture(t); absent.offline(); await absent.manager.hostPair.select("0.2.0", absent.nextHost, async () => {});
  assert.deepEqual((await readPair(absent.storage))!.selections, []); assert.deepEqual(absent.calls(), { downloads: 0, registry: 0 });
  const disabled = await fixture(t); await disabled.manager.installer.installArchive(id, disabled.old.bytes, integrity(disabled.old.bytes), "0.1.0");
  await disabled.manager.hostPair.select("0.2.0", disabled.nextHost, async () => {}); await disabled.restart();
  assert.equal((await disabled.manager.inventory()).plugins[0]!.enabled, false); assert.equal(disabled.manager.tools.length, 0);
  const pinned = await fixture(t); await pinned.manager.installer.installArchive(id, pinned.old.bytes, integrity(pinned.old.bytes), "0.1.0");
  await mkdir(join(pinned.storage, "policies"), { recursive: true });
  await atomicJson(join(pinned.storage, "policies/policies.json"), { [id]: { updatePolicy: "pinned", pinnedVersion: "0.1.0" } });
  await pinned.manager.hostPair.select("0.2.0", pinned.nextHost, async () => {});
  assert.deepEqual(pinned.calls(), { downloads: 1, registry: 1 });
  await pinned.restart();
  assert.equal((await pinned.manager.inventory()).plugins[0]!.version, "0.2.0");
  assert.deepEqual(JSON.parse(await readFile(join(pinned.storage, "policies/policies.json"), "utf8")), { [id]: { updatePolicy: "notify" } });
  const newer = integrationFixture("0.3.0", false, ">=0.1.0 <0.2.0");
  const downgrade = await fixture(t); await downgrade.manager.installer.installArchive(id, newer.bytes, integrity(newer.bytes), "0.3.0");
  // No plugin downgrade is guessed; the host update proceeds and the plugin is left out of the pair.
  await downgrade.manager.hostPair.select("0.2.0", downgrade.nextHost, async () => {});
  assert.deepEqual((await readPair(downgrade.storage))!.selections, []);
  assert.deepEqual((await downgrade.manager.installer.inventory()).versions[id]!.map(v => v.version), ["0.3.0"]);
});

test("plugin drift never refuses selection or restart; host metadata/tampering and cross-process owners still do", async t => {
  const f = await fixture(t); await writeFile(join(f.nextHost, "package.json"), JSON.stringify({ name: "pi-webapp", version: "0.2.0" }));
  await assert.rejects(candidateHost("0.2.0", f.nextHost), /explicit hosted/);
  await host(f.nextHost, "0.2.0", f.worker);
  let state = 1, pointers = 0;
  const drifting = pairTransaction(f.storage, async () => { state++; throw new Error("plugin prefetch failed"); }, async () => state);
  await drifting.select("0.2.0", f.nextHost, async () => { pointers++; });
  assert.equal(pointers, 1, "plugin drift or a failed plugin prefetch never refuses the host");
  await drifting.cancel!("0.2.0", f.nextHost, async () => {});
  await withStorageLock(pairRoot(f.storage), async () => {
    const storageUrl = new URL("../src/host/server/plugins/hosted/storage.ts", import.meta.url).href;
    const script = `const {withStorageLock}=await import(${JSON.stringify(storageUrl)}); try {await withStorageLock(process.argv[1],async()=>{},50);process.exit(2)} catch(e){if(e.code!=="storage_busy")throw e}`;
    await promisify(execFile)(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, pairRoot(f.storage)], { timeout: 15000 });
  });
  const stable = pairTransaction(f.storage, async () => {}, async () => state);
  await stable.select("0.2.0", f.nextHost, async () => {}); state++;
  let restarts = 0;
  await stable.restart("0.2.0", f.nextHost, async () => { restarts++; });
  assert.equal(restarts, 1, "a plugin change after selection does not refuse the restart");
  await stable.cancel!("0.2.0", f.nextHost, async () => {});
  await stable.select("0.2.0", f.nextHost, async () => {});
  await writeFile(join(f.nextHost, "dist/hosted-worker.js"), "tampered");
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
      assert.equal((await f.manager.inventory()).plugins[0]!.error, undefined, "a host fallback is not a plugin failure");
      assert.match((await readPair(f.storage))!.message!, /Selected host not running/);
    }
    f.offline(); await f.restart();
    if (after) {
      assert.equal((await f.manager.inventory()).plugins[0]!.activeVersion, "0.2.0");
      assert.equal((await readPair(f.storage))!.phase, "reconciled");
    } else {
      // The fallback host already ended this attempt. The selected host then picks the installed
      // release that supports it, per plugin, without any staged plan.
      const card = (await f.manager.inventory()).plugins[0]!;
      assert.equal(card.activeVersion, "0.2.0"); assert.equal(card.error, undefined);
      assert.equal((await readPair(f.storage))!.phase, "cancelled");
    }
  });
});

test("hard process exit releases kernel custody and reconciles selected pair without offline recovery", async t => {
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
  const before = (await readPair(f.storage))!;
  const database = join(pairRoot(f.storage), "transaction.ownership.sqlite"), inode = (await stat(database)).ino;
  assert.equal(before.phase, "selecting");
  // The OS, not PID inference or an operator unlink, releases custody. The
  // existing journal must still validate the selected host and plugin package.
  f.offline(); await f.restart();
  assert.equal((await f.manager.inventory()).plugins[0]!.activeVersion, "0.2.0");
  assert.equal((await readPair(f.storage))!.phase, "reconciled");
  assert.equal((await readPair(f.storage))!.id, before.id);
  assert.equal((await stat(database)).ino, inode, "kernel lock inode is never replaced");
  await assert.rejects(readFile(join(pairRoot(f.storage), "transaction.lock")), { code: "ENOENT" });
});

test("candidate without crash-safe ownership support is refused before selecting a downgrade", async t => {
  const f = await fixture(t);
  const path = join(f.nextHost, "package.json"), pkg = JSON.parse(await readFile(path, "utf8"));
  delete pkg.piWebappHostedRuntime.ownershipProtocol;
  await writeFile(path, JSON.stringify(pkg));
  await assert.rejects(f.manager.hostPair.select("0.2.0", f.nextHost, async () => assert.fail("must not write selection")), /crash-safe ownership/);
  assert.equal(await readPair(f.storage), null);
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
  assert.match((await f.manager.inventory()).plugins[0]!.error!.message, /Plugin unavailable.*data retained/);
  assert.equal(fingerprint(await broker.active()), fingerprint(before));
});

test("a plugin's startup failure stays on its card and never fences host updates", async t => {
  const f = await fixture(t), compatible = integrationFixture("0.1.0", false, ">=0.1.0 <1.0.0");
  await f.manager.installer.installArchive(id, compatible.bytes, integrity(compatible.bytes), "0.1.0");
  await f.manager.manage(id, "enable");
  f.offline();
  await f.manager.hostPair.select("0.2.0", f.nextHost, async () => {});
  // The plugin is enabled but outside the selected pair, and its code is missing (e.g. a dev plugin never installed).
  const intentPath = join(pairRoot(f.storage), "intent.json"), indexPath = join(f.storage, "packages", "installed.json");
  await writeFile(intentPath, JSON.stringify({ ...JSON.parse(await readFile(intentPath, "utf8")), selections: [] }));
  const index = JSON.parse(await readFile(indexPath, "utf8"));
  await writeFile(indexPath, JSON.stringify({ ...index, versions: { ...index.versions, [id]: [] } }));
  await f.restart();
  assert.match((await f.manager.inventory()).plugins[0]!.error!.message, /not_installed/);
  assert.equal((await readPair(f.storage))!.phase, "reconciled");
  await f.manager.setPolicy(id, { updatePolicy: "notify" });
  await f.manager.hostPair.select("0.2.0", f.nextHost, async () => {});
});

test("a settled required-action journal is archived and superseded by the next update; only in-flight updates fence", async t => {
  const f = await fixture(t), intentPath = join(pairRoot(f.storage), "intent.json");
  await f.manager.hostPair.select("0.2.0", f.nextHost, async () => {});
  await assert.rejects(f.manager.hostPair.stage!("0.2.0", f.nextHost), /0\.2\.0 is in progress \(selected\)/);
  const stuck = { ...JSON.parse(await readFile(intentPath, "utf8")), phase: "required-action", message: "old failure" };
  await writeFile(intentPath, JSON.stringify(stuck));
  await f.manager.setPolicy(id, { updatePolicy: "notify" });
  await f.manager.hostPair.stage!("0.2.0", f.nextHost);
  assert.equal((await readPair(f.storage))!.phase, "prepared");
  const archived = JSON.parse(await readFile(join(pairRoot(f.storage), "history", `${stuck.id}.json`), "utf8"));
  assert.equal(archived.phase, "required-action"); assert.match(archived.message, /Superseded by a new update; old failure/);
});

// Hosts up to 0.1.50 fence every update on any disk phase outside this list.
const legacyPending = (phase: string) => !["prepared", "reconciled", "cancelled"].includes(phase);

test("a settled required-action is written in a disk phase that older hosts never treat as in flight", async t => {
  const f = await fixture(t), intentPath = join(pairRoot(f.storage), "intent.json");
  await f.manager.hostPair.select("0.2.0", f.nextHost, async () => {});
  await writePair(f.storage, { ...(await readPair(f.storage))!, phase: "required-action", message: "plugin failed" });
  const disk = JSON.parse(await readFile(intentPath, "utf8"));
  assert.equal(disk.phase, "reconciled"); assert.equal(disk.lifecyclePhase, "required-action");
  assert.equal(legacyPending(disk.phase), false, "an older fallback host can still update past it");
  assert.equal((await readPair(f.storage))!.phase, "required-action");
  await f.manager.hostPair.stage!("0.2.0", f.nextHost);
  assert.equal((await readPair(f.storage))!.phase, "prepared");
});

test("offline settle-pair clears a stale required-action left by an older host, and nothing else", async t => {
  const f = await fixture(t), root = pairRoot(f.storage), intentPath = join(root, "intent.json");
  await f.manager.hostPair.select("0.2.0", f.nextHost, async () => {});
  const selected = await inspectStoppedStorage(root);
  await assert.rejects(settleStoppedPair(f.storage, selected.fingerprint, STOPPED_CONFIRMATION), /Only a required-action journal/);
  assert.equal((await readPair(f.storage))!.phase, "selected", "an in-flight selection is never settled offline");
  // An older host writes the raw phase directly, which it then refuses to update past.
  const stuck = { ...JSON.parse(await readFile(intentPath, "utf8")), phase: "required-action", message: "plugin startup failed (not_installed)" };
  await writeFile(intentPath, JSON.stringify(stuck));
  const report = await inspectStoppedStorage(root);
  await assert.rejects(settleStoppedPair(f.storage, report.fingerprint, "yes"), /confirmation/);
  await assert.rejects(settleStoppedPair(f.storage, selected.fingerprint, STOPPED_CONFIRMATION), /changed since inspection/);
  assert.deepEqual(await settleStoppedPair(f.storage, report.fingerprint, STOPPED_CONFIRMATION), { settled: stuck.id, version: "0.2.0", fingerprint: report.fingerprint });
  const disk = JSON.parse(await readFile(intentPath, "utf8"));
  assert.equal(disk.phase, "reconciled"); assert.equal(legacyPending(disk.phase), false);
  assert.match(disk.message, /Settled offline.*not_installed/);
  assert.equal(JSON.parse(await readFile(join(root, "history", `${stuck.id}-settled-${report.fingerprint}.json`), "utf8")).phase, "required-action", "the original record is retained");
  await assert.rejects(settleStoppedPair(f.storage, report.fingerprint, STOPPED_CONFIRMATION), /changed since inspection/, "a fingerprint is never reused");
  await f.manager.hostPair.stage!("0.2.0", f.nextHost);
  assert.equal((await readPair(f.storage))!.phase, "prepared");
});

test("plugin management is never refused by the pair journal, even mid-selection", async t => {
  const f = await fixture(t), compatible = integrationFixture("0.1.0", false, ">=0.1.0 <1.0.0");
  await f.manager.hostPair.select("0.2.0", f.nextHost, async () => {});
  assert.equal((await readPair(f.storage))!.phase, "selected");
  await f.manager.installer.installArchive(id, compatible.bytes, integrity(compatible.bytes), "0.1.0");
  await f.manager.manage(id, "enable"); assert.equal(f.manager.tools.length, 1);
  await f.manager.setPolicy(id, { updatePolicy: "notify" });
  await f.manager.manage(id, "disable"); assert.equal(f.manager.tools.length, 0);
  await f.manager.manage(id, "uninstall");
  assert.equal((await f.manager.inventory()).plugins[0]!.installed, false);
  assert.equal((await readPair(f.storage))!.phase, "selected", "plugin actions never rewrite host-update state");
});

test("startup re-encodes an old host's raw required-action so 0.1.50-era hosts can update past it", async t => {
  const f = await fixture(t), intentPath = join(pairRoot(f.storage), "intent.json");
  await f.manager.hostPair.select("0.2.0", f.nextHost, async () => {});
  await writeFile(intentPath, JSON.stringify({ ...JSON.parse(await readFile(intentPath, "utf8")), phase: "required-action", message: "plugin startup failed (not_installed)" }));
  await f.restart("0.1.29");
  const disk = JSON.parse(await readFile(intentPath, "utf8"));
  assert.equal(legacyPending(disk.phase), false); assert.equal(disk.lifecyclePhase, "required-action");
  assert.equal((await readPair(f.storage))!.phase, "required-action");
});

test("an in-flight pair journal that stops making progress is abandoned and superseded, with history kept", async t => {
  const f = await fixture(t), intentPath = join(pairRoot(f.storage), "intent.json");
  await f.manager.hostPair.select("0.2.0", f.nextHost, async () => {});
  await assert.rejects(f.manager.hostPair.stage!("0.2.0", f.nextHost), /in progress/, "a live switch still fences a second one");
  const live = JSON.parse(await readFile(intentPath, "utf8"));
  // A record written by an older host has no updatedAt: its file time decides.
  const { updatedAt: _omitted, ...legacy } = live;
  await writeFile(intentPath, JSON.stringify(legacy));
  const old = new Date(Date.now() - PAIR_STALE_MS - 60_000);
  await utimes(intentPath, old, old);
  assert.equal(activePair(await readPair(f.storage)), false);
  await f.manager.hostPair.stage!("0.2.0", f.nextHost);
  assert.equal((await readPair(f.storage))!.phase, "prepared");
  const history = JSON.parse(await readFile(join(pairRoot(f.storage), "history", `${live.id}.json`), "utf8"));
  assert.equal(history.phase, "cancelled"); assert.match(history.message, /Abandoned after no progress/);
});

test("a corrupt or unknown-schema pair journal is quarantined and never fences the next update", async t => {
  for (const bytes of ["{not json", JSON.stringify({ schema: 7, phase: "selected" })]) {
    const f = await fixture(t), intentPath = join(pairRoot(f.storage), "intent.json");
    await mkdir(pairRoot(f.storage), { recursive: true }); await writeFile(intentPath, bytes);
    await f.manager.hostPair.stage!("0.2.0", f.nextHost);
    assert.equal((await readPair(f.storage))!.phase, "prepared");
  }
});
