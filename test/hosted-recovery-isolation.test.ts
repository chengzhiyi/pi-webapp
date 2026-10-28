import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { HostedPluginIntegration } from "../src/host/server/plugins/hosted/integration.ts";
import { HostedStateBroker } from "../src/host/server/plugins/hosted/state-broker.ts";
import { WorkspaceSessions } from "../src/host/server/sessions/workspace-sessions.ts";
import { hostedId as id, integrationFixture, integrity } from "./helpers/hosted-integration-fixture.ts";

async function fixture(t: { after(fn: () => Promise<void>): void }, changed = () => {}) {
  const root = await mkdtemp(join(tmpdir(), "hosted-recovery-isolation-"));
  const workerEntry = join(root, "worker.mjs");
  await build({ entryPoints: [new URL("../src/host/server/plugins/hosted/worker-entry.ts", import.meta.url).pathname], outfile: workerEntry, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  const scope = { cwd: root, sessionId: "retained", workspaceId: "workspace" };
  const integration = new HostedPluginIntegration({ root: join(root, "hosted"), hostVersion: "0.1.29", workerEntry,
    ownerId: "isolated-test", resolveSession: sessionId => sessionId === scope.sessionId ? scope : null, changed });
  t.after(async () => { await integration.shutdown(); await rm(root, { recursive: true, force: true }); });
  await integration.start();
  const archive = integrationFixture();
  await integration.manager.installer.installArchive(id, archive.bytes, integrity(archive.bytes), "0.1.0");
  return { root, integration, scope, broker: new HostedStateBroker(join(root, "hosted", "data"), id) };
}

test("committed plugin publication failure releases chat admission and can recover locally", async t => {
  let failPublication = true;
  const f = await fixture(t, () => { if (failPublication) throw new Error("isolated publication fault"); });
  await assert.rejects(f.integration.manage({ pluginId: id, operation: "enable" }), /publication|recovery/);
  assert.equal(f.integration.adapter.isFrozen, false, "one plugin's publication failure must not freeze all chats");
  const current = await f.broker.active();
  assert.equal(current?.enabled, true, "committed data is retained, not silently rolled back");
  await assert.rejects(f.integration.handlers.action({ ...f.scope, pluginId: id, generation: current!.generation,
    action: "list", input: {} }), /unavailable|recovery|publication/i);
  failPublication = false;
  await f.integration.manage({ pluginId: id, operation: "disable" });
  await f.integration.manage({ pluginId: id, operation: "enable" });
  assert.equal((await f.integration.inventory()).plugins[0]!.phase, "active");
  assert.equal(f.integration.adapter.isFrozen, false);
});

test("failed restart commit resumes actual old worker with identical state and generation", async t => {
  const f = await fixture(t);
  await f.integration.manage({ pluginId: id, operation: "enable" });
  const active = (await f.broker.active())!;
  await f.broker.call({ requestId: "save-before-restart", generation: active.generation, scope: f.scope,
    kind: "action", action: "save", input: {} }, "state.compareAndSwap", {
    key: "retained-draft", expectedRevision: 0, schema: 1, value: { text: "do not lose 用户图稿", revision: 9 },
  });
  const before = await readFile(join(f.broker.root, "active.json"));
  const resume = await f.integration.prepareRestart();
  assert.equal(f.integration.adapter.isFrozen, true);
  await resume();
  await resume();
  assert.equal(f.integration.adapter.isFrozen, false);
  assert.deepEqual(await readFile(join(f.broker.root, "active.json")), before);
  const card = (await f.integration.inventory()).plugins[0]!;
  assert.equal(card.phase, "active"); assert.equal(card.generation, active.generation);
  const persisted = await f.broker.call({ requestId: "read-after-rollback", generation: active.generation,
    scope: f.scope, kind: "action", action: "read", input: {} }, "state.read", { key: "retained-draft" }) as { value: unknown };
  assert.deepEqual(persisted.value, { text: "do not lose 用户图稿", revision: 9 });
  const reply = await f.integration.handlers.action({ pluginId: id, sessionId: f.scope.sessionId,
    generation: active.generation, action: "list", input: {} }) as { version: string };
  assert.equal(reply.version, "0.1.0", "a real replacement worker handles the original generation");
});

test("ownership release failure after worker stop restores current plugin before rejecting restart", async t => {
  const f = await fixture(t);
  await f.integration.manage({ pluginId: id, operation: "enable" });
  const active = (await f.broker.active())!;
  const before = await readFile(join(f.broker.root, "active.json"));
  const supervisor = (f.integration.manager as any).supervisors.get(id);
  const release = supervisor.releaseOwnership;
  let rejectRelease = true;
  supervisor.releaseOwnership = async () => {
    // A marker-unlink I/O failure happens before actual kernel custody is released.
    if (rejectRelease) { rejectRelease = false; throw new Error("isolated marker unlink failure"); }
    await release();
  };
  try {
    await assert.rejects(f.integration.prepareRestart(), /isolated marker unlink failure/);
    assert.equal(f.integration.adapter.isFrozen, false);
    assert.equal(supervisor.phase, "active");
    assert.equal(supervisor.generation, active.generation, "active means a real worker at the retained generation exists");
    const reply = await f.integration.handlers.action({ pluginId: id, sessionId: f.scope.sessionId,
      generation: active.generation, action: "list", input: {} }) as { version: string };
    assert.equal(reply.version, "0.1.0");
    assert.deepEqual(await readFile(join(f.broker.root, "active.json")), before);
  } finally { supervisor.releaseOwnership = release; }
});

test("manager publication failure before integration hook denies plugin work and still shuts down", async t => {
  const f = await fixture(t);
  const load = f.integration.manager.installer.load.bind(f.integration.manager.installer);
  let rejectCommittedLoad = true;
  f.integration.manager.installer.load = async (...args) => {
    if (rejectCommittedLoad && (await f.broker.active())?.enabled) {
      rejectCommittedLoad = false;
      throw new Error("isolated post-commit package publication failure");
    }
    return load(...args);
  };
  try {
    await assert.rejects(f.integration.manage({ pluginId: id, operation: "enable" }), /publication|recovery/i);
    const active = (await f.broker.active())!;
    assert.equal(active.enabled, true);
    assert.equal(f.integration.adapter.isFrozen, false);
    assert.equal((await f.integration.inventory()).plugins[0]!.phase, "reconnect-required");
    await assert.rejects(f.integration.adapter.invokeAction(id, f.scope, "list", {}), /policy|unavailable/i);
    await assert.rejects(f.integration.handlers.action({ pluginId: id, sessionId: f.scope.sessionId,
      generation: active.generation, action: "list", input: {} }), /unavailable|recovery/i);
  } finally { f.integration.manager.installer.load = load; }
  await f.integration.shutdown();
  assert.equal((f.integration.manager as any).supervisors.get(id).pid, undefined);
});

test("plugin storage startup failure does not prevent a retained SDK chat", async t => {
  const root = await mkdtemp(join(tmpdir(), "hosted-corrupt-isolation-"));
  const prior = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  await mkdir(join(root, "hosted", "packages"), { recursive: true });
  await writeFile(join(root, "hosted", "packages", "installed.json"), "{corrupt");
  const integration = new HostedPluginIntegration({ root: join(root, "hosted"), hostVersion: "0.1.29", workerEntry: "unused",
    ownerId: "isolated-test", resolveSession: () => null });
  const sessions = new WorkspaceSessions(() => {}, () => undefined, () => false, undefined, undefined, undefined, [],
    { adapter: integration.adapter, scope: (cwd, sessionId) => ({ cwd, sessionId, workspaceId: "workspace" }) });
  t.after(async () => {
    await sessions.dispose(); await integration.shutdown();
    if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior;
    await rm(root, { recursive: true, force: true });
  });
  await integration.start(); await sessions.open(root, "new");
  const retained = sessions.session!, model = retained.modelRuntime.getModels("openai")[0]!;
  await retained.modelRuntime.setRuntimeApiKey("openai", "local-fixture-not-a-provider-key"); await retained.setModel(model);
  retained.agent.streamFunction = async model => {
    const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
      timestamp: Date.now(), content: [{ type: "text", text: "base chat remains available" }], stopReason: "stop",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = createAssistantMessageEventStream(); stream.push({ type: "done", reason: "stop", message }); stream.end(message); return stream;
  };
  await retained.prompt("local fixture chat");
  assert.ok(retained.messages.some(message => message.role === "assistant" && message.stopReason === "stop"));
  assert.equal(integration.adapter.isFrozen, false);
  assert.equal(await readFile(join(root, "hosted", "packages", "installed.json"), "utf8"), "{corrupt");
});
