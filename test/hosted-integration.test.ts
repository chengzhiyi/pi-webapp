import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { HostedPluginIntegration } from "../src/host/server/plugins/hosted/integration.ts";
import { WorkspaceSessions } from "../src/host/server/sessions/workspace-sessions.ts";
import { HostedStateBroker } from "../src/host/server/plugins/hosted/state-broker.ts";
import { startBridge } from "../src/host/server/transport/bridge.ts";
import { NodeTelemetry } from "../src/platform/telemetry/telemetry.ts";
import { terminalHost } from "./helpers/terminal-host.ts";
import { hostedId as id, integrationFixture, integrity } from "./helpers/hosted-integration-fixture.ts";
const latch = () => { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { resolve, promise }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

test("production orchestration: authenticated HTTP + actual manager/worker + retained SDK batches, no reload", { timeout: 30000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hosted-integration-")));
  const prior = process.env.PI_CODING_AGENT_DIR, roots = process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent"); process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS = "";
  const workerEntry = join(root, "worker.mjs");
  await build({ entryPoints: [new URL("../src/host/server/plugins/hosted/worker-entry.ts", import.meta.url).pathname], outfile: workerEntry, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  let sessions!: WorkspaceSessions, requests = 0, selected = integrationFixture();
  let downloadGate: { entered: ReturnType<typeof latch>; release: ReturnType<typeof latch> } | undefined;
  const scope = (cwd: string, sessionId: string) => ({ cwd, sessionId, workspaceId: "trusted-workspace" });
  const options = { root: join(root, "hosted"), hostVersion: "0.1.29", workerEntry, ownerId: "host-local-auth-principal",
    resolveSession: (sessionId: string) => { const retained = sessions?.hostedScope(sessionId); return retained ? scope(retained.cwd, sessionId) : null; },
    fetch: (async (url: string | URL | Request) => {
      requests++;
      if (String(url).endsWith(".tgz") && downloadGate) { downloadGate.entered.resolve(); await downloadGate.release.promise; }
      return String(url).endsWith(".tgz") ? new Response(selected.bytes) : new Response(JSON.stringify({ versions: { [selected.release.version]: selected.release } }));
    }) as typeof fetch,
  };
  let integration = new HostedPluginIntegration(options);
  sessions = new WorkspaceSessions(() => {}, () => undefined, () => false, undefined, undefined, undefined, [], { adapter: integration.adapter, scope });
  await integration.start(); assert.equal(requests, 0, "absent official card never downloads code");
  await sessions.open(root, "new"); const first = sessions.session!, sessionId = first.sessionManager.getSessionId();
  let reloads = 0; sessions.reload = async () => { reloads++; throw new Error("reload forbidden"); };
  const { host } = terminalHost(root); host.hosted = integration.handlers;
  const bridge = await startBridge(host, new URL("../web/dist", import.meta.url).pathname, new NodeTelemetry({ env: { PI_WEB_SENTRY_ENABLED: "false" }, monitor: false }), { pluginSettingsFile: join(root, "preferences.json") });
  t.after(async () => {
    integration.adapter.thaw(); await integration.shutdown(); await bridge.close(); await sessions.dispose();
    if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior;
    if (roots === undefined) delete process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS; else process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS = roots;
    await rm(root, { recursive: true, force: true });
  });
  const url = new URL(bridge.url), headers = { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, "Content-Type": "application/json" };
  const post = (route: string, body: unknown) => fetch(url.origin + "/api/hosted-plugins/" + route, { method: "POST", headers, body: JSON.stringify(body) });
  const manage = (operation: string, extra = {}) => post("manage", { pluginId: id, operation, ...extra });
  const card = async () => (await integration.inventory()).plugins[0]!;
  assert.equal((await manage("install")).status, 200); assert.equal((await card()).enabled, false);
  const enabled = await manage("enable"); assert.equal(enabled.status, 200);
  const enabledCatalog = await enabled.json(); assert.equal(enabledCatalog.plugins[0].pluginId, id); assert.ok(enabledCatalog.plugins[0].contribution.toolViews.includes("diagram_create"));
  const generation = (await card()).generation!;
  assert.equal((await fetch(url.origin + enabledCatalog.plugins[0].documentUrl)).status, 200);
  assert.equal(first.getAllTools().filter(tool => tool.name === "diagram_read").length, 1);
  const builtinCatalog = JSON.stringify(await (await fetch(url.origin + "/api/plugins", { headers })).json());
  assert.doesNotMatch(builtinCatalog, /@pi-webapp\/diagrams/);
  assert.match(builtinCatalog, /@pi-webapp\/files/); assert.match(builtinCatalog, /@pi-webapp\/terminal/); assert.match(builtinCatalog, /@pi-webapp\/git/);
  assert.equal((await fetch(url.origin + "/api/diagrams/list", { method: "POST", headers, body: JSON.stringify({ sessionId }) })).status, 404);
  const action = { pluginId: id, generation, sessionId, action: "list", input: {} };
  assert.equal((await post("action", { ...action, sessionId: "disk-only-forged", cwd: root })).status, 403);
  assert.equal((await post("action", { ...action, generation: generation + 1 })).status, 409);
  assert.equal((await post("action", { ...action, action: "raw-broker" })).status, 403);
  const trusted = await (await post("action", { ...action, cwd: "/forged", workspaceId: "forged", ownerId: "forged" })).json();
  assert.deepEqual(trusted.scope, scope(root, sessionId));
  await sessions.open(root, "new"); const second = sessions.session!;
  assert.ok(second.getActiveToolNames().includes("diagram_read"), "new sessions get current tools before first prompt");
  const model = first.modelRuntime.getModels("openai")[0]!;
  await first.modelRuntime.setRuntimeApiKey("openai", "fixture-no-network"); await first.setModel(model);
  const entered = latch(), release = latch(); let stage = 0;
  first.agent.streamFunction = async model => {
    if (++stage === 1) { entered.resolve(); await release.promise; }
    const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
      content: stage === 1 ? [{ type: "toolCall", id: "old-batch", name: "diagram_read", arguments: { value: "old" } }] : [{ type: "text", text: "done" }], stopReason: stage === 1 ? "toolUse" : "stop",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = createAssistantMessageEventStream(); stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message }); stream.end(message); return stream;
  };
  const batch = first.prompt("background batch admitted before freeze"); await entered.promise;
  selected = integrationFixture("0.2.0");
  downloadGate = { entered: latch(), release: latch() };
  const freezeEntered = latch(), freezeAdapter = integration.adapter.freeze.bind(integration.adapter);
  integration.adapter.freeze = () => { const promise = freezeAdapter(); freezeEntered.resolve(); return promise; };
  const updating = integration.manage({ pluginId: id, operation: "update" });
  const checking = integration.manage({ pluginId: id, operation: "check" });
  await downloadGate.entered.promise;
  assert.equal(integration.adapter.isFrozen, false, "network preparation must not freeze retained Agent sessions");
  assert.equal((await post("action", action)).status, 200, "old editor stays usable while archive is downloading");
  downloadGate.release.resolve(); downloadGate = undefined;
  await freezeEntered.promise; assert.equal(integration.adapter.isFrozen, true);
  assert.equal((await post("action", action)).status, 409, "normal UI actions denied at outer prefreeze");
  release.resolve(); await batch; await updating; await checking;
  const result = first.messages.find(message => message.role === "toolResult" && message.toolCallId === "old-batch");
  assert.ok(result?.role === "toolResult" && !result.isError); assert.equal((result.details as { version: string }).version, "0.1.0", "old schema batch finishes on ACTIVE old worker before manager drain");
  assert.equal(sessions.session, second); assert.equal(sessions.retainedSessions().length, 2); assert.equal(reloads, 0);
  assert.match(first.getAllTools().find(tool => tool.name === "diagram_read")!.description, /0.2.0/);
  assert.match(second.getAllTools().find(tool => tool.name === "diagram_read")!.description, /0.2.0/);
  const current = (await card()).generation!;
  const identity = { pluginId: id, sessionId, generation: current, mountId: "window-one" };
  const registered = await (await post("views", { ...identity, operation: "register", kind: "editor" })).json();
  const view = { ...identity, viewToken: registered.viewToken };
  assert.equal((await post("views", { ...view, operation: "change", dirty: false, busy: false })).status, 200);
  const pending = await integration.manage({ pluginId: id, operation: "enable" }); assert.equal(pending.plugins[0]!.pendingVersion, "0.2.0");
  const switching = integration.manage({ pluginId: id, operation: "retry", reopenEditors: true });
  const poll = await (await post("views", { ...view, operation: "poll", after: 0 })).json();
  const freeze = poll.commands.find((command: { type: string }) => command.type === "freeze"); assert.ok(freeze);
  assert.equal((await post("action", { ...action, ...view, action: "sync", viewToken: "forged" })).status, 409);
  assert.equal((await post("action", { ...action, ...view, action: "save" })).status, 409);
  assert.equal((await post("action", { ...action, ...view, action: "sync" })).status, 200, "only reviewed checkpoint actions with exact active barrier capability may flush");
  assert.equal((await post("views", { ...view, sessionId: "forged", operation: "ack", commandId: freeze.id, ok: true })).status, 403);
  assert.equal((await post("views", { ...view, operation: "ack", commandId: freeze.id, ok: true })).status, 200);
  await switching;
  assert.equal((await post("action", { ...action, ...view })).status, 409, "old generation fenced after commit");
  assert.equal((await post("views", { ...view, operation: "change", dirty: true, busy: false })).status, 409);
  await post("views", { ...view, operation: "close" });
  const before = await new HostedStateBroker(join(options.root, "data"), id).active();
  selected = integrationFixture("0.3.0", true);
  assert.equal((await manage("update")).status, 500);
  assert.deepEqual(await new HostedStateBroker(join(options.root, "data"), id).active(), before, "unverified readonly descriptor fails BEFORE persistent activation");
  assert.ok((await card()).error); assert.equal(integration.adapter.isFrozen, false);
  const closingIdentity = { pluginId: id, sessionId, generation: (await card()).generation!, mountId: "editor-to-disable" };
  const closingRegistration = await (await post("views", { ...closingIdentity, operation: "register", kind: "editor" })).json();
  const closingView = { ...closingIdentity, viewToken: closingRegistration.viewToken };
  await post("views", { ...closingView, operation: "change", dirty: true, busy: false });
  const disabling = manage("disable");
  const closingPoll = await (await post("views", { ...closingView, operation: "poll", after: 0 })).json();
  const closingFreeze = closingPoll.commands.find((command: { type: string }) => command.type === "freeze");
  assert.ok(closingFreeze, "explicit disable drains an open editor instead of treating it as an automatic update");
  await post("views", { ...closingView, operation: "ack", commandId: closingFreeze.id, ok: true });
  assert.equal((await disabling).status, 200);
  await post("views", { ...closingView, operation: "close" });
  assert.equal(first.getAllTools().find(tool => tool.name === "diagram_read")!.exposure, "hidden");
  assert.equal((await manage("uninstall")).status, 200); assert.equal((await card()).installed, false); assert.equal(reloads, 0);
  await integration.shutdown();
  const callsBeforeRestart = requests;
  integration = new HostedPluginIntegration(options); host.hosted = integration.handlers; await integration.start();
  assert.equal(requests, callsBeforeRestart, "host-version marker prevents repeated reconciliation");
});

test("publication failure is visible, never thaws admission or claims successful management", async t => {
  const root = await mkdtemp(join(tmpdir(), "hosted-publication-")), workerEntry = join(root, "worker.mjs");
  await build({ entryPoints: [new URL("../src/host/server/plugins/hosted/worker-entry.ts", import.meta.url).pathname], outfile: workerEntry, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  const integration = new HostedPluginIntegration({ root, hostVersion: "0.1.29", workerEntry, ownerId: "local", resolveSession: () => null, changed: () => { throw new Error("publication failed"); } });
  await integration.start(); const fixture = integrationFixture(); await integration.manager.installer.installArchive(id, fixture.bytes, integrity(fixture.bytes), "0.1.0");
  await assert.rejects(integration.manage({ pluginId: id, operation: "enable" }), /publication failed|recovery required/);
  assert.equal(integration.adapter.isFrozen, true); assert.match((await integration.inventory()).plugins[0]!.error!, /publication failed/);
  assert.equal((await new HostedStateBroker(join(root, "data"), id).active())?.enabled, true, "new generation/data never silently rolled back");
  // Recovery stays sticky for new work, but graceful shutdown must drain and release ownership.
  const active = await new HostedStateBroker(join(root, "data"), id).active();
  await integration.shutdown();
  assert.deepEqual(await new HostedStateBroker(join(root, "data"), id).active(), active, "shutdown never disables or rolls back committed state");
  t.after(() => rm(root, { recursive: true, force: true }));
});
