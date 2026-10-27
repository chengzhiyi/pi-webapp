import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import { HostedPluginIntegration } from "../src/host/server/plugins/hosted/integration.ts";
import { HostedStateBroker } from "../src/host/server/plugins/hosted/state-broker.ts";
import { readPair } from "../src/host/server/updates/hosted-pair.ts";
import { SelfUpdater } from "../src/host/server/updates/self-update.ts";
import { startBridge } from "../src/host/server/transport/bridge.ts";
import { NodeTelemetry } from "../src/platform/telemetry/telemetry.ts";
import { terminalHost } from "./helpers/terminal-host.ts";
import { hostedId as id, integrationFixture, integrity } from "./helpers/hosted-integration-fixture.ts";

const contract = { protocol: 2, runtimeProtocol: 1, pairJournal: 1, capabilities: ["state", "workspace", "legacy", "panels", "messages"] };
async function hostPackage(root: string, version: string, worker: Buffer) {
  for (const dir of ["bin", "dist", "web/dist"]) await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "pi-webapp", version, piWebappHostedRuntime: contract }));
  await writeFile(join(root, "dist/hosted-worker.js"), worker);
  for (const file of ["bin/pi-webapp.mjs", "dist/extension.js", "web/dist/index.html"]) await writeFile(join(root, file), "synthetic host; never executed");
}
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "hosted-restart-")), storage = join(root, "hosted"), oldHost = join(root, "old");
  const workerEntry = join(root, "worker.mjs");
  await build({ entryPoints: [new URL("../src/host/server/plugins/hosted/worker-entry.ts", import.meta.url).pathname], outfile: workerEntry, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  const worker = await readFile(workerEntry); await hostPackage(oldHost, "0.1.32", worker);
  const plugin = integrationFixture("0.1.1");
  let registry = 0;
  const options = { root: storage, hostVersion: "0.1.32", packageRoot: oldHost, workerEntry, ownerId: "owner",
    resolveSession: (sessionId: string) => sessionId === "terminal-a" ? { sessionId, cwd: root, workspaceId: "workspace" } : null,
    fetch: (async () => { registry++; return Response.json({ versions: { "0.1.1": plugin.release } }); }) as typeof fetch };
  const integration = new HostedPluginIntegration(options);
  await integration.start();
  await integration.manager.installer.installArchive(id, plugin.bytes, integrity(plugin.bytes), "0.1.1");
  await integration.manage({ pluginId: id, operation: "enable" });
  const broker = new HostedStateBroker(join(storage, "data"), id);
  t.after(async () => { await integration.shutdown(); await rm(root, { recursive: true, force: true }); });
  return { root, storage, oldHost, worker, options, integration, broker, registry: () => registry };
}

for (const rejectFirst of [false, true]) test(`paired HTTP update drains views before restart marker${rejectFirst ? "; rejected flush retries exact selection" : ""}`, { timeout: 30000 }, async t => {
  const f = await fixture(t), { host } = terminalHost(f.root);
  let installs = 0;
  const updater = new SelfUpdater({ agentDir: f.root, packageRoot: f.oldHost, launcherNonce: "test-nonce", desktopManaged: false,
    hostedPair: f.integration.manager.hostPair, beforeRestart: () => f.integration.shutdown(),
    runNpm: async args => {
      if (args[0] === "view") return '"0.1.33"';
      installs++;
      await hostPackage(join(args[args.indexOf("--prefix") + 1]!, "node_modules/pi-webapp"), "0.1.33", f.worker);
      return "";
    } });
  host.selfUpdate = updater; host.hosted = f.integration.handlers;
  const bridge = await startBridge(host, new URL("../web/dist", import.meta.url).pathname,
    new NodeTelemetry({ env: { PI_WEB_SENTRY_ENABLED: "false" }, monitor: false }), { pluginSettingsFile: join(f.root, "preferences.json") });
  t.after(() => bridge.close());
  const url = new URL(bridge.url), headers = { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, "Content-Type": "application/json" };
  const post = (path: string, body: unknown, overrides = {}) => fetch(url.origin + "/api/" + path, { method: "POST", headers: { ...headers, ...overrides }, body: JSON.stringify(body) });
  const before = await f.broker.active(), generation = before!.generation;
  const identity = { pluginId: id, sessionId: "terminal-a", generation, mountId: "drawing" };
  const registration = await post("hosted-plugins/views", { ...identity, operation: "register", kind: "editor" });
  const view = { ...identity, viewToken: (await registration.json()).viewToken };
  await post("hosted-plugins/views", { ...view, operation: "change", dirty: true, busy: false });
  const action = { ...view, input: {}, action: "sync" };
  const marker = join(f.root, "pi-web/launcher.restart"), lock = join(f.broker.root, "runtime.lock");
  const lockBefore = await readFile(lock);
  let cursor = 0;
  for (let attempt = 0; attempt < (rejectFirst ? 2 : 1); attempt++) {
    const update = post("update", { sessionId: "terminal-a" });
    // PollMany must remain usable even while the updater fences ordinary mutations.
    let freeze: { id: number; type: string } | undefined;
    for (let n = 0; n < 200 && !freeze; n++) {
      const reply = await post("hosted-plugins/views", { operation: "pollMany", views: [{ ...view, operation: "poll", after: cursor }] });
      assert.equal(reply.status, 200);
      freeze = (await reply.json()).replies[0].reply.commands.find((command: { type: string; id: number }) => command.type === "freeze" && command.id > cursor);
      if (!freeze) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(freeze, "shutdown must begin while HTTP checkpoint transport remains live"); cursor = freeze.id;
    await assert.rejects(readFile(marker), { code: "ENOENT" });
    assert.deepEqual(await readFile(lock), lockBefore, "ownership is not released before flushing");
    assert.equal((await post("hosted-plugins/manage", { pluginId: id, operation: "disable" })).status, 409);
    assert.equal((await post("hosted-plugins/views", { ...identity, mountId: "new", operation: "register", kind: "editor" })).status, 409);
    assert.equal((await post("hosted-plugins/views", { ...view, operation: "discard", confirmation: "discard-unconfirmed-edits" })).status, 409);
    assert.equal((await post("hosted-plugins/views", { ...view, operation: "change", dirty: true, busy: false })).status, 200);
    assert.equal((await post("hosted-plugins/action", { ...action, action: "save", checkpointOnly: false, draining: false })).status, 409);
    assert.equal((await post("hosted-plugins/action", { ...action, viewToken: "forged" })).status, 409);
    assert.equal((await post("hosted-plugins/action", { ...action, sessionId: "forged" })).status, 403);
    assert.equal((await post("hosted-plugins/action", action, { Authorization: "Bearer invalid" })).status, 401);
    assert.equal((await post("hosted-plugins/action", action, { Origin: "https://other.invalid" })).status, 403);
    assert.equal((await post("hosted-plugins/action", action)).status, 200);
    const reject = rejectFirst && attempt === 0;
    assert.equal((await post("hosted-plugins/views", { ...view, operation: "ack", commandId: freeze.id, ok: !reject, ...(reject ? { error: "test flush refused" } : {}) })).status, 200);
    const result = await update;
    assert.equal(result.status, reject ? 400 : 202);
    if (reject) {
      assert.match((await result.json()).error, /test flush refused/);
      await assert.rejects(readFile(marker), { code: "ENOENT" });
      assert.deepEqual(await readFile(lock), lockBefore);
      assert.equal(f.integration.adapter.isFrozen, false);
      assert.equal((await post("hosted-plugins/action", { ...action, action: "list" })).status, 200);
      assert.equal((await readPair(f.storage))!.phase, "selected");
      await assert.rejects(updater.prepare({ version: "0.1.34", channel: "stable" }), /已有待重启/);
    }
  }
  assert.equal(installs, 1, "retry must reuse the retained selection, never bypass or replace its journal");
  await assert.rejects(readFile(lock), { code: "ENOENT" });
  assert.deepEqual(await f.broker.active(), before, "shutdown preserves enabled intent, active generation and stateRef");
  const restart = JSON.parse(await readFile(marker, "utf8")); assert.equal(restart.nonce, "test-nonce");
  await f.integration.shutdown(); // session_shutdown after pre-restart drain is idempotent.
  const pair = (await readPair(f.storage))!;
  const next = new HostedPluginIntegration({ ...f.options, hostVersion: "0.1.33", packageRoot: pair.packageRoot });
  try {
    await next.start();
    assert.equal((await next.inventory()).plugins[0]!.phase, "active");
    assert.equal((await readPair(f.storage))!.phase, "reconciled");
  } finally { await next.shutdown(); }
});

test("pending pair retains the real startup ownership error and never reclaims a dead PID lock", async t => {
  const f = await fixture(t), nextHost = join(f.root, "next");
  await hostPackage(nextHost, "0.1.33", f.worker);
  await f.integration.manager.hostPair.select("0.1.33", nextHost, async () => {});
  await f.integration.shutdown();
  const lock = join(f.broker.root, "runtime.lock"), bytes = '{"pid":2147483647,"ownerId":"abandoned-test-owner"}';
  await writeFile(lock, bytes);
  const before = await f.broker.active(), registry = f.registry();
  const next = new HostedPluginIntegration({ ...f.options, hostVersion: "0.1.33", packageRoot: nextHost });
  try {
    await next.start();
    const card = (await next.inventory()).plugins[0]!;
    assert.equal(card.phase, "disabled"); assert.equal(card.errorCode, "runtime_owned");
    assert.match(card.error!, /Another host owns.*offline hosted-recovery/s);
    assert.match((await readPair(f.storage))!.message!, /runtime_owned/);
    assert.equal(f.registry(), registry, "startup reconciliation must not overwrite the error with its own pair fence");
    assert.equal(await readFile(lock, "utf8"), bytes);
    assert.deepEqual(await f.broker.active(), before);
    await assert.rejects(next.manager.hostPair.select("0.1.33", nextHost, async () => assert.fail("must not select")), /0.1.33, required-action.*runtime_owned/s);
  } finally { await next.shutdown(); }
  assert.equal(createHash("sha256").update(await readFile(lock)).digest("hex"), createHash("sha256").update(bytes).digest("hex"));
});
