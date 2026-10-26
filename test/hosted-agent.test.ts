import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { HostedAgentAdapter, type HostedAgentPolicy } from "../src/host/server/plugins/hosted/agent-adapter.ts";
import { WorkspaceSessions } from "../src/host/server/sessions/workspace-sessions.ts";
import type { HostedToolDescriptor } from "@chengzhiyi/pi-web-protocol";

const descriptor = (version = 1): HostedToolDescriptor => ({ name: "hosted_echo", label: "Echo", description: `Exact schema ${version}`, action: `echo.${version}`, readonly: true,
  parameters: { type: "object", properties: { value: { type: version === 1 ? "string" : "number" } }, required: ["value"], additionalProperties: false } });
function latch() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
const tick = () => new Promise(resolve => setImmediate(resolve));

test("real SDK: same retained objects, exact schemas, settled batch barrier, admission and host-only tombstones", { timeout: 20000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hosted-agent-"));
  const prior = process.env.PI_CODING_AGENT_DIR, roots = process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS;
  process.env.PI_CODING_AGENT_DIR = join(cwd, "agent"); process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS = "";
  let policy: HostedAgentPolicy = { enabled: true, allowNested: true };
  const requests: Array<{ action: string; input: unknown; sessionId: string }> = [];
  const held = latch(), entered = latch();
  const adapter = new HostedAgentAdapter({ policy: () => policy, invoke: async (_id, request) => {
    requests.push({ action: request.action, input: request.input, sessionId: request.scope.sessionId });
    if ((request.input as { value?: unknown }).value === "hold") { entered.resolve(); await held.promise; }
    return { content: [{ type: "text", text: JSON.stringify(request.input) }], details: undefined };
  } });
  const workspaces = new WorkspaceSessions(() => {}, () => undefined, () => false, undefined, undefined, undefined, [], { adapter, scope: (cwd, sessionId) => ({ cwd, sessionId, workspaceId: "trusted-workspace" }) });
  try {
    await workspaces.open(cwd, "new"); const first = workspaces.session!;
    let shutdowns = 0; // Runtime identity is stronger than merely counting shutdown notifications.
    const originalDispose = first.dispose.bind(first); first.dispose = () => { shutdowns++; originalDispose(); };
    await adapter.freeze(); adapter.change("fixture", [descriptor()]); adapter.thaw();
    assert.deepEqual(first.getAllTools().find(t => t.name === "hosted_echo")?.parameters, descriptor().parameters);
    await workspaces.open(cwd, "new"); const second = workspaces.session!;
    assert.ok(second.getAllTools().some(t => t.name === "hosted_echo"));
    const model = first.modelRuntime.getModels("openai")[0]!;
    await first.modelRuntime.setRuntimeApiKey("openai", "fixture-no-network"); await first.setModel(model);
    let stage = 0;
    const followup = latch(), finalEntered = latch();
    first.agent.streamFunction = async model => {
      stage++;
      if (stage === 2) { finalEntered.resolve(); await followup.promise; }
      const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        content: stage === 1 ? [{ type: "toolCall", id: "old-a", name: "hosted_echo", arguments: { value: "hold" } }, { type: "toolCall", id: "old-b", name: "hosted_echo", arguments: { value: "old-schema" } }] : [{ type: "text", text: "done" }],
        stopReason: stage === 1 ? "toolUse" : "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream(); stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message }); stream.end(message); return stream;
    };
    const running = first.prompt("old batch in retained background session"); await entered.promise;
    let drained = false; const frozen = adapter.freeze().then(() => { drained = true; });
    assert.throws(() => adapter.change("fixture", [descriptor(2)]), /settled/);
    await assert.rejects(workspaces.send("new foreground batch"), /switching/);
    held.resolve(); await finalEntered.promise; await tick();
    assert.equal(drained, false, "plugin-call idle is NOT agent_settled");
    assert.equal(requests.length, 2); assert.ok(requests.every(r => r.action === "echo.1"));
    followup.resolve(); await running; await frozen;
    const gated = first.prompt("TUI/direct SDK admission while frozen"); await tick();
    assert.equal(stage, 2, "frozen direct SDK prompt has not reached its provider");
    adapter.change("fixture", [descriptor(2)]); adapter.thaw(); await gated;
    assert.equal(stage, 3);
    assert.equal(workspaces.session, second); assert.equal(shutdowns, 0);
    assert.deepEqual(first.getAllTools().find(t => t.name === "hosted_echo")?.parameters, descriptor(2).parameters);
    assert.deepEqual(second.getAllTools().find(t => t.name === "hosted_echo")?.parameters, descriptor(2).parameters);
    await adapter.freeze(); adapter.change("fixture", []); adapter.thaw();
    for (const session of [first, second]) {
      const hidden = session.getAllTools().find(t => t.name === "hosted_echo")!;
      assert.equal(hidden.exposure, "hidden"); assert.equal(hidden.description, "Unavailable host tool");
      assert.deepEqual(hidden.parameters, { type: "object", properties: {} });
      session.setActiveToolsByName(["hosted_echo"]);
      assert.ok(!session.getActiveToolNames().includes("hosted_echo"));
    }
    await adapter.freeze(); policy = { enabled: false }; adapter.change("fixture", [descriptor()]); adapter.thaw();
    assert.equal(first.getAllTools().find(t => t.name === "hosted_echo")?.exposure, "hidden");
    await adapter.freeze(); policy = { enabled: true }; adapter.change("fixture", [descriptor()]);
    assert.throws(() => adapter.change("other-plugin", [descriptor()]), /ownership/);
    assert.throws(() => adapter.change("fixture", [{ ...descriptor(), name: "read" }]), /another extension or builtin/);
    adapter.thaw(); assert.equal(shutdowns, 0);
    await workspaces.open(cwd, { sessionId: first.sessionManager.getSessionId() }); assert.equal(workspaces.session, first);
  } finally {
    adapter.thaw(); await workspaces.dispose();
    await adapter.freeze(); adapter.change("fixture", []); adapter.thaw(); // disposed bindings removed
    if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior;
    if (roots === undefined) delete process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS; else process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS = roots;
    await rm(cwd, { recursive: true, force: true });
  }
});
