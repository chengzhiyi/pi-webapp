import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import { HostedPluginManager } from "../src/host/server/plugins/hosted/manager.ts";
import { HostedPluginIntegration } from "../src/host/server/plugins/hosted/integration.ts";
import { HostedStateBroker } from "../src/host/server/plugins/hosted/state-broker.ts";
import { atomicJson } from "../src/host/server/plugins/hosted/storage.ts";
import { activePair, candidateHost, fingerprint, PAIR_STALE_MS, pairRoot, readPair, writePair } from "../src/host/server/updates/hosted-pair.ts";
import { inspectStoppedStorage, settleStoppedPair, STOPPED_CONFIRMATION } from "../src/host/server/plugins/hosted/stopped-recovery.ts";
import { SelfUpdater } from "../src/host/server/updates/self-update.ts";
import { readCandidate } from "../bin/upgrade-transaction.mjs";
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
  const root = await mkdtemp(join(tmpdir(), "host-upgrade-plugins-")), storage = join(root, "hosted"), workerEntry = join(root, "worker.mjs");
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
type Fixture = Awaited<ReturnType<typeof fixture>>;
/** A host-pair journal exactly as a 0.1.50-era host leaves it: raw phase, no updatedAt. */
async function legacyJournal(f: Fixture, phase: string, version = "0.2.0", packageRoot = f.nextHost, extra: Record<string, unknown> = {}) {
  const record = { schema: 1 as const, id: randomUUID(), phase, version, packageRoot, hostDigest: await candidateHost(version, packageRoot), fingerprint: "0".repeat(64), selections: [], ...extra };
  await mkdir(pairRoot(f.storage), { recursive: true });
  await writeFile(join(pairRoot(f.storage), "intent.json"), JSON.stringify(record));
  return record;
}
// Hosts up to 0.1.50 fence every update and plugin action on any disk phase outside this list.
const legacyPending = (phase: string) => !["prepared", "reconciled", "cancelled"].includes(phase);
const npmHost = (f: Fixture) => async (args: string[]) => {
  if (args[0] === "view") return JSON.stringify("0.2.0");
  await host(join(args[args.indexOf("--prefix") + 1]!, "node_modules/pi-webapp"), "0.2.0", f.worker); return "";
};

test("npm and desktop host updates only download, validate and name a candidate; the new host picks compatible plugins offline", async t => {
  for (const desktopManaged of [false, true]) await t.test(desktopManaged ? "desktop" : "npm", async t => {
    const f = await fixture(t);
    await f.manager.installer.installArchive(id, f.old.bytes, integrity(f.old.bytes), "0.1.0");
    await f.manager.manage(id, "enable");
    const generation = f.manager.tools[0]!.generation;
    const updater = new SelfUpdater({ agentDir: f.root, packageRoot: f.oldHost, launcherNonce: "nonce",
      prefetchPlugins: (version, signal) => f.manager.prefetchForHost(version, signal),
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
    assert.deepEqual(f.calls(), { downloads: 1, registry: 1 }, "an incompatible plugin release was prefetched for the target");
    assert.equal(f.manager.tools[0]!.generation, generation, "the running plugin is untouched");
    assert.equal((await f.manager.inventory()).plugins[0]!.activeVersion, "0.1.0");
    const candidate = (await readCandidate(f.root))!;
    assert.equal(candidate.version, "0.2.0"); assert.equal(candidate.launcher, prepared.launcher);
    await f.manager.setPolicy(id, { updatePolicy: "notify" });
    await updater.requestRestart(prepared);
    assert.deepEqual(JSON.parse(await readFile(join(f.root, "pi-web/launcher.restart"), "utf8")), { nonce: "nonce", candidate: candidate.id });
    // The host wrote no pointer and no host-pair journal: selection belongs to the launcher.
    await assert.rejects(readFile(join(f.root, "pi-web", desktopManaged ? "desktop-update.json" : "update.json")), { code: "ENOENT" });
    assert.equal(await readPair(f.storage), null);
    f.offline(); const manager = await f.restart();
    assert.equal((await manager.inventory()).plugins[0]!.activeVersion, "0.2.0");
    assert.equal(manager.tools.length, 1);
    await f.restart(); assert.equal((await f.manager.inventory()).plugins[0]!.activeVersion, "0.2.0");
  });
});

test("a compatible independent plugin is retained across a host update without consulting the registry", async t => {
  const f = await fixture(t), compatible = integrationFixture("0.1.0", false, ">=0.1.0 <1.0.0");
  await f.manager.installer.installArchive(id, compatible.bytes, integrity(compatible.bytes), "0.1.0");
  await f.manager.prefetchForHost("0.2.0");
  assert.deepEqual(f.calls(), { downloads: 0, registry: 0 });
  await f.restart();
  assert.equal((await f.manager.inventory()).plugins[0]!.version, "0.1.0");
  assert.equal((await f.manager.inventory()).plugins[0]!.enabled, false);
});

test("an alpha host keeps its exact preview identity and an enabled stable plugin across an offline restart", async t => {
  const f = await fixture(t), version = "0.1.31-alpha.5";
  const compatible = integrationFixture("0.1.0", false, ">=0.1.0 <1.0.0");
  await host(f.nextHost, version, f.worker);
  await f.manager.installer.installArchive(id, compatible.bytes, integrity(compatible.bytes), "0.1.0");
  await f.manager.manage(id, "enable");
  f.offline();
  await f.manager.prefetchForHost(version);
  await f.restart(version);
  const card = (await f.manager.inventory()).plugins[0]!;
  assert.equal(card.enabled, true); assert.equal(card.activeVersion, "0.1.0");
  assert.equal(f.manager.installer.hostVersion, version);
  assert.equal(f.manager.tools.length, 1);
});

test("an offline host update retains compatible plugin code without a spurious network diagnostic", async t => {
  const f = await fixture(t), compatible = integrationFixture("0.1.0", false, ">=0.1.0 <1.0.0");
  await f.manager.installer.installArchive(id, compatible.bytes, integrity(compatible.bytes), "0.1.0");
  f.offline(); await f.manager.prefetchForHost("0.2.0");
  assert.equal((await f.manager.inventory()).plugins[0]!.updateDiagnostic, undefined);
  await f.restart();
  assert.equal((await f.manager.inventory()).plugins[0]!.version, "0.1.0");
});

test("compatible plugin startup on a new host stays independent of online plugin update availability", async t => {
  const f = await fixture(t), compatible = integrationFixture("0.1.0", false, ">=0.1.0 <1.0.0");
  await f.manager.installer.installArchive(id, compatible.bytes, integrity(compatible.bytes), "0.1.0");
  f.offline(); await f.manager.prefetchForHost("0.2.0"); await f.manager.shutdown();
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

test("production integration activates the prefetched compatible release offline without a second registry selection", async t => {
  const f = await fixture(t);
  await f.manager.installer.installArchive(id, f.old.bytes, integrity(f.old.bytes), "0.1.0"); await f.manager.manage(id, "enable");
  await f.manager.prefetchForHost("0.2.0"); await f.manager.shutdown(); f.offline();
  const integration = new HostedPluginIntegration({ ...f.options, packageRoot: f.nextHost, hostVersion: "0.2.0", ownerId: "local", resolveSession: () => null });
  try {
    await integration.start();
    assert.equal(integration.manager.tools.length, 1);
    assert.equal((await integration.inventory()).plugins[0]!.version, "0.2.0");
    assert.equal(JSON.parse(await readFile(join(f.storage, "host-version.json"), "utf8")).version, "0.2.0");
    assert.equal(await readPair(f.storage), null);
    assert.deepEqual(f.calls(), { downloads: 1, registry: 1 });
  } finally { await integration.shutdown(); }
});

test("an offline incompatible plugin never blocks the host update; it starts unavailable with data retained", async t => {
  const f = await fixture(t); await f.manager.installer.installArchive(id, f.old.bytes, integrity(f.old.bytes), "0.1.0"); await f.manager.manage(id, "enable");
  const before = await f.manager.pairSnapshot(); f.offline();
  await f.manager.prefetchForHost("0.2.0");
  assert.deepEqual(await f.manager.pairSnapshot(), before);
  assert.equal(f.manager.tools.length, 1, "the running plugin keeps working until restart");
  assert.match((await f.manager.hostUpdateWarnings("0.2.0"))[0]!.message, /unavailable after the update/);
  await f.restart();
  const card = (await f.manager.inventory()).plugins[0]!;
  assert.equal(card.activeVersion, "0.1.0"); assert.match(card.error!.message, /Plugin unavailable.*data retained/s);
  assert.equal(f.manager.tools.length, 0);
  await f.restart("0.1.29"); assert.equal(f.manager.tools.length, 1);
});

test("absent never downloads; disabled stays disabled; legacy pin is retired; no downgrade is guessed", async t => {
  const absent = await fixture(t); absent.offline(); await absent.manager.prefetchForHost("0.2.0");
  assert.deepEqual(absent.calls(), { downloads: 0, registry: 0 });
  const disabled = await fixture(t); await disabled.manager.installer.installArchive(id, disabled.old.bytes, integrity(disabled.old.bytes), "0.1.0");
  await disabled.manager.prefetchForHost("0.2.0"); await disabled.restart();
  assert.equal((await disabled.manager.inventory()).plugins[0]!.enabled, false); assert.equal(disabled.manager.tools.length, 0);
  const pinned = await fixture(t); await pinned.manager.installer.installArchive(id, pinned.old.bytes, integrity(pinned.old.bytes), "0.1.0");
  await mkdir(join(pinned.storage, "policies"), { recursive: true });
  await atomicJson(join(pinned.storage, "policies/policies.json"), { [id]: { updatePolicy: "pinned", pinnedVersion: "0.1.0" } });
  await pinned.manager.prefetchForHost("0.2.0");
  assert.deepEqual(pinned.calls(), { downloads: 1, registry: 1 });
  await pinned.restart();
  assert.equal((await pinned.manager.inventory()).plugins[0]!.version, "0.2.0");
  assert.deepEqual(JSON.parse(await readFile(join(pinned.storage, "policies/policies.json"), "utf8")), { [id]: { updatePolicy: "notify" } });
  const newer = integrationFixture("0.3.0", false, ">=0.1.0 <0.2.0");
  const downgrade = await fixture(t); await downgrade.manager.installer.installArchive(id, newer.bytes, integrity(newer.bytes), "0.3.0");
  await downgrade.manager.prefetchForHost("0.2.0");
  assert.deepEqual((await downgrade.manager.installer.inventory()).versions[id]!.map(v => v.version), ["0.3.0"]);
});

test("startup never overrides a newer confirmed disable when choosing a compatible plugin version", async t => {
  const f = await fixture(t); await f.manager.installer.installArchive(id, f.old.bytes, integrity(f.old.bytes), "0.1.0"); await f.manager.manage(id, "enable");
  await f.manager.prefetchForHost("0.2.0");
  const broker = new HostedStateBroker(join(f.storage, "data"), id), before = (await broker.active())!;
  const newer = await broker.activate(before.generation, { ...before, enabled: false });
  await f.restart(); assert.deepEqual(await broker.active(), newer); assert.equal(f.manager.tools.length, 0);
});

test("pinned real external archive and built worker across two synthetic host package versions; native incompatible runtime is refused with data retained", { skip: !process.env.ORI38_EXCALIDRAW_TGZ }, async t => {
  const f = await fixture(t), bytes = await readFile(process.env.ORI38_EXCALIDRAW_TGZ!);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), process.env.ORI38_EXCALIDRAW_SHA256 ?? "0036300e1647f0b79a2f565514645859639725ab0d167de005f32ca7988e9d97");
  await f.manager.installer.installArchive(id, bytes, integrity(bytes), "0.1.0"); await f.manager.manage(id, "enable"); f.offline();
  await f.manager.prefetchForHost("0.2.0"); await f.restart();
  assert.equal(f.manager.tools[0]!.descriptors.length, 6);
  const broker = new HostedStateBroker(join(f.storage, "data"), id), before = await broker.active();
  await f.manager.setPolicy(id, { updatePolicy: "pinned", pinnedVersion: "0.1.0" });
  // Manual native-shell replacement is not an OS installer transaction.
  await f.restart("0.0.1"); assert.equal(f.manager.tools.length, 0);
  assert.deepEqual(await broker.active(), before);
  assert.match((await f.manager.inventory()).plugins[0]!.error!.message, /Plugin unavailable.*data retained/);
  assert.equal(fingerprint(await broker.active()), fingerprint(before));
});

test("an uninstalled, enabled plugin stays on its own card and the host update still prepares and restarts", async t => {
  const f = await fixture(t), compatible = integrationFixture("0.1.0", false, ">=0.1.0 <1.0.0");
  await f.manager.installer.installArchive(id, compatible.bytes, integrity(compatible.bytes), "0.1.0");
  await f.manager.manage(id, "enable");
  // The situation that wedged 0.1.50: enabled, but its code is missing from installed.json.
  const indexPath = join(f.storage, "packages", "installed.json"), index = JSON.parse(await readFile(indexPath, "utf8"));
  await writeFile(indexPath, JSON.stringify({ ...index, versions: { ...index.versions, [id]: [] } }));
  f.offline(); await f.restart("0.1.29");
  assert.match((await f.manager.inventory()).plugins[0]!.error!.message, /not_installed/);
  assert.equal(await readPair(f.storage), null, "a plugin failure never writes host-update state");
  const updater = new SelfUpdater({ agentDir: f.root, packageRoot: f.oldHost, launcherNonce: "nonce", runNpm: npmHost(f),
    pluginWarnings: version => f.manager.hostUpdateWarnings(version), prefetchPlugins: (version, signal) => f.manager.prefetchForHost(version, signal) });
  assert.match((await updater.check()).pluginWarnings![0]!.message, /not installed/);
  await updater.requestRestart(await updater.prepare());
  assert.equal(JSON.parse(await readFile(join(f.root, "pi-web/launcher.restart"), "utf8")).nonce, "nonce");
  await f.manager.setPolicy(id, { updatePolicy: "notify" });
});

test("plugin management is never refused by a host-pair journal, even one an older host left mid-switch", async t => {
  const f = await fixture(t), compatible = integrationFixture("0.1.0", false, ">=0.1.0 <1.0.0");
  await legacyJournal(f, "selected");
  await f.manager.installer.installArchive(id, compatible.bytes, integrity(compatible.bytes), "0.1.0");
  await f.manager.manage(id, "enable"); assert.equal(f.manager.tools.length, 1);
  await f.manager.setPolicy(id, { updatePolicy: "notify" });
  await f.manager.manage(id, "disable"); assert.equal(f.manager.tools.length, 0);
  await f.manager.manage(id, "uninstall");
  assert.equal((await f.manager.inventory()).plugins[0]!.installed, false);
  assert.equal((await readPair(f.storage))!.phase, "selected", "plugin actions never rewrite host-update state");
});

test("an older host's in-flight journal settles at startup: cancelled when a fallback runs, reconciled when its host runs", async t => {
  const f = await fixture(t); await f.manager.installer.installArchive(id, f.old.bytes, integrity(f.old.bytes), "0.1.0"); await f.manager.manage(id, "enable");
  await f.manager.prefetchForHost("0.2.0");
  await legacyJournal(f, "selecting");
  await f.restart("0.1.29"); assert.equal(f.manager.tools.length, 1);
  assert.equal((await f.manager.inventory()).plugins[0]!.error, undefined, "a host fallback is not a plugin failure");
  assert.equal((await readPair(f.storage))!.phase, "cancelled"); assert.match((await readPair(f.storage))!.message!, /Selected host not running/);
  await legacyJournal(f, "selected");
  f.offline(); await f.restart();
  assert.equal((await readPair(f.storage))!.phase, "reconciled");
  const card = (await f.manager.inventory()).plugins[0]!;
  assert.equal(card.activeVersion, "0.2.0"); assert.equal(card.error, undefined);
  assert.equal(legacyPending(JSON.parse(await readFile(join(pairRoot(f.storage), "intent.json"), "utf8")).phase), false);
});

test("a hard exit while holding the pair lock releases kernel custody; the next startup settles without offline recovery", async t => {
  const f = await fixture(t);
  await f.manager.installer.installArchive(id, f.old.bytes, integrity(f.old.bytes), "0.1.0"); await f.manager.manage(id, "enable");
  await f.manager.prefetchForHost("0.2.0");
  await f.manager.shutdown(); // No live runtime owner remains before the child starts.
  const before = await legacyJournal(f, "selecting");
  const storageUrl = new URL("../src/host/server/plugins/hosted/storage.ts", import.meta.url).href;
  const script = `const {withStorageLock}=await import(${JSON.stringify(storageUrl)}); await withStorageLock(process.argv[1],async()=>{process.exit(0)}); process.exit(2);`;
  await promisify(execFile)(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, pairRoot(f.storage)], { timeout: 15000 });
  const database = join(pairRoot(f.storage), "transaction.ownership.sqlite"), inode = (await stat(database)).ino;
  // The OS, not PID inference or an operator unlink, releases custody.
  f.offline(); await f.restart();
  assert.equal((await f.manager.inventory()).plugins[0]!.activeVersion, "0.2.0");
  assert.equal((await readPair(f.storage))!.phase, "reconciled");
  assert.equal((await readPair(f.storage))!.id, before.id);
  assert.equal((await stat(database)).ino, inode, "kernel lock inode is never replaced");
  await assert.rejects(readFile(join(pairRoot(f.storage), "transaction.lock")), { code: "ENOENT" });
});

test("startup re-encodes an older host's raw required-action so 0.1.50-era hosts can update past it", async t => {
  const f = await fixture(t), intentPath = join(pairRoot(f.storage), "intent.json");
  await legacyJournal(f, "required-action", "0.2.0", f.nextHost, { message: "plugin startup failed (not_installed)" });
  await f.restart("0.1.29");
  const disk = JSON.parse(await readFile(intentPath, "utf8"));
  assert.equal(legacyPending(disk.phase), false); assert.equal(disk.lifecyclePhase, "required-action");
  assert.equal((await readPair(f.storage))!.phase, "required-action");
});

test("every journal new code writes is one 0.1.50-era hosts treat as settled", async t => {
  const f = await fixture(t), intentPath = join(pairRoot(f.storage), "intent.json");
  const base = { ...(await legacyJournal(f, "selected")), phase: "selected" as const };
  for (const phase of ["required-action", "cancelled", "reconciled"] as const) {
    await writePair(f.storage, { ...base, phase, message: phase });
    const disk = JSON.parse(await readFile(intentPath, "utf8"));
    assert.equal(legacyPending(disk.phase), false, phase); assert.deepEqual(disk.selections, []);
    assert.equal((await readPair(f.storage))!.phase, phase);
  }
});

test("a corrupt or unknown-schema journal is quarantined and never fences startup or an update", async t => {
  for (const bytes of ["{not json", JSON.stringify({ schema: 7, phase: "selected" })]) {
    const f = await fixture(t), intentPath = join(pairRoot(f.storage), "intent.json");
    await mkdir(pairRoot(f.storage), { recursive: true }); await writeFile(intentPath, bytes);
    await f.restart("0.1.29");
    assert.equal(await readPair(f.storage), null);
    const updater = new SelfUpdater({ agentDir: f.root, packageRoot: f.oldHost, launcherNonce: "nonce", runNpm: npmHost(f) });
    await updater.requestRestart(await updater.prepare());
  }
});

test("an in-flight journal from an older host that stops making progress is no longer active", async t => {
  const f = await fixture(t), intentPath = join(pairRoot(f.storage), "intent.json");
  await legacyJournal(f, "selected");
  assert.equal(activePair(await readPair(f.storage)), true);
  const old = new Date(Date.now() - PAIR_STALE_MS - 60_000);
  await utimes(intentPath, old, old);
  assert.equal(activePair(await readPair(f.storage)), false, "records without updatedAt fall back to the file time");
});

test("offline settle-pair clears a stale required-action left by an older host, and nothing else", async t => {
  const f = await fixture(t), root = pairRoot(f.storage), intentPath = join(root, "intent.json");
  await legacyJournal(f, "selected");
  const selected = await inspectStoppedStorage(root);
  await assert.rejects(settleStoppedPair(f.storage, selected.fingerprint, STOPPED_CONFIRMATION), /Only a required-action journal/);
  assert.equal((await readPair(f.storage))!.phase, "selected", "an in-flight selection is never settled offline");
  // An older host writes the raw phase directly, which it then refuses to update past.
  const stuck = await legacyJournal(f, "required-action", "0.2.0", f.nextHost, { message: "plugin startup failed (not_installed)" });
  const report = await inspectStoppedStorage(root);
  await assert.rejects(settleStoppedPair(f.storage, report.fingerprint, "yes"), /confirmation/);
  await assert.rejects(settleStoppedPair(f.storage, selected.fingerprint, STOPPED_CONFIRMATION), /changed since inspection/);
  assert.deepEqual(await settleStoppedPair(f.storage, report.fingerprint, STOPPED_CONFIRMATION), { settled: stuck.id, version: "0.2.0", fingerprint: report.fingerprint });
  const disk = JSON.parse(await readFile(intentPath, "utf8"));
  assert.equal(disk.phase, "reconciled"); assert.equal(legacyPending(disk.phase), false);
  assert.match(disk.message, /Settled offline.*not_installed/);
  assert.equal(JSON.parse(await readFile(join(root, "history", `${stuck.id}-settled-${report.fingerprint}.json`), "utf8")).phase, "required-action", "the original record is retained");
  await assert.rejects(settleStoppedPair(f.storage, report.fingerprint, STOPPED_CONFIRMATION), /changed since inspection/, "a fingerprint is never reused");
});

test("this package keeps the hosted metadata that 0.1.50-era hosts require before they will update to it", async () => {
  // Older hosts validate a candidate's package.json before selecting it; dropping these fields
  // would make every older install refuse the update that contains their fix.
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const runtime = pkg.piWebappHostedRuntime;
  assert.equal(runtime.protocol, 2); assert.equal(runtime.runtimeProtocol, 1); assert.equal(runtime.pairJournal, 1); assert.equal(runtime.ownershipProtocol, 2);
  for (const capability of ["state", "workspace", "legacy", "panels", "messages"]) assert.ok(runtime.capabilities.includes(capability), capability);
  assert.equal(pkg.piWebappDesktopProtocol, 1);
});
