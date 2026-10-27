import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { HostedAgentAdapter, type HostedAgentService } from "../src/host/server/plugins/hosted/agent-adapter.ts";
import { HostedStateBroker } from "../src/host/server/plugins/hosted/state-broker.ts";

const pluginId = "request-id-fixture";
const descriptor = { name: "hosted_store", label: "Store", description: "Store through the real host broker", action: "store",
  parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } };
const modelIds = [
  "call_574d5da2df3b4e5a9e7d816c8223eeaa|fc_0161b0be4666df4c016ae0a73c891c81909bd4501bae62e92e",
  "call_a|fc_b", "call_afc_b", // Deleting punctuation would alias these distinct calls.
  "call_" + "x".repeat(200), "调用:含空格 / Unicode",
];

test("real SDK -> hosted adapter -> broker: opaque model IDs stay in transcript, unique internal leases reach storage", { timeout: 20000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hosted-request-id-"));
  const broker = new HostedStateBroker(join(cwd, "storage"), pluginId);
  const requests: Array<Parameters<HostedAgentService["invoke"]>[1]> = [];
  const sessions: AgentSession[] = [];
  const detach: Array<() => void> = [];
  const adapter = new HostedAgentAdapter({ policy: () => ({ enabled: true }), invoke: async (_id, request) => {
    requests.push(request);
    const invocation = { ...request, generation: 1 };
    const key = "scene-" + request.requestId;
    assert.equal(await broker.call(invocation, "state.read", { key }), null);
    const value = { sessionId: request.scope.sessionId, input: request.input };
    await broker.call(invocation, "state.compareAndSwap", { key, expectedRevision: 0, schema: 1, value });
    const saved = await broker.call(invocation, "state.read", { key });
    assert.deepEqual(saved, { revision: 1, schema: 1, value });
    return { content: [{ type: "text", text: JSON.stringify(saved) }], details: undefined };
  } });
  try {
    await broker.activate(0, { version: "0.1.0", stateRef: randomUUID(), schema: 1, enabled: true });
    await adapter.freeze(); adapter.change(pluginId, [descriptor]); adapter.thaw();
    for (const mode of ["inline", "tui"] as const) {
      const manager = SessionManager.inMemory(cwd);
      const scope = { cwd, workspaceId: "trusted-workspace", sessionId: manager.getSessionId() };
      const loader = new DefaultResourceLoader({ cwd, agentDir: join(cwd, "agent"), noExtensions: true, noSkills: true, noPromptTemplates: true,
        extensionFactories: [mode === "inline" ? adapter.extension(scope) : pi => {
          pi.on("session_start", () => { detach.push(adapter.mountTui(pi, scope)); });
        }] });
      await loader.reload();
      const { session } = await createAgentSession({ cwd, sessionManager: manager, resourceLoader: loader, noTools: "builtin" });
      sessions.push(session);
      if (mode === "inline") detach.push(adapter.attach(session));
      await session.bindExtensions({ mode: "print" });
      const model = session.modelRuntime.getModels("openai")[0]!;
      await session.modelRuntime.setRuntimeApiKey("openai", "fixture-no-network"); await session.setModel(model);
    }
    for (let round = 0; round < 2; round++) {
      // Reuse provider IDs both across sessions and across turns. Each execution needs its own lease.
      await Promise.all(sessions.map(async (session, sessionIndex) => {
        let stage = 0;
        session.agent.streamFunction = async model => {
          const first = stage++ === 0;
          const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
            content: first ? modelIds.map((id, index) => ({ type: "toolCall" as const, id, name: descriptor.name, arguments: { value: `${sessionIndex}/${round}/${index}` } })) : [{ type: "text", text: "done" }],
            stopReason: first ? "toolUse" : "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
          const stream = createAssistantMessageEventStream(); stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: first ? "toolUse" : "stop", message }); stream.end(message); return stream;
        };
        await session.prompt("Store values using opaque provider call IDs");
        const results = session.messages.filter(message => message.role === "toolResult");
        assert.equal(results.length, modelIds.length * (round + 1));
        assert.ok(results.every(result => !result.isError), JSON.stringify(results.filter(result => result.isError)));
        assert.deepEqual(results.slice(-modelIds.length).map(result => result.toolCallId).sort(), [...modelIds].sort(), "model result correlation must preserve the original IDs");
        const calls = session.messages.flatMap(message => message.role === "assistant" ? message.content.filter(block => block.type === "toolCall").map(block => block.id) : []);
        assert.deepEqual(calls, Array.from({ length: round + 1 }, () => modelIds).flat(), "assistant transcript IDs must not be rewritten");
      }));
    }
    assert.equal(requests.length, modelIds.length * 4);
    assert.equal(new Set(requests.map(request => request.requestId)).size, requests.length, "parallel sessions and repeated model IDs must not share an internal lease");
    for (const request of requests) {
      assert.match(request.requestId, /^[\w-]{1,160}$/);
      assert.ok(!modelIds.includes(request.requestId));
      assert.equal(request.scope.cwd, cwd);
      assert.equal(request.scope.workspaceId, "trusted-workspace");
      assert.ok(sessions.some(session => session.sessionManager.getSessionId() === request.scope.sessionId));
    }
    // The adaptation must not weaken broker validation or generation fencing.
    const valid = { ...requests[0]!, generation: 1 };
    await assert.rejects(broker.call({ ...valid, requestId: modelIds[0]! }, "state.read", { key: "probe" }), error => (error as { code: string }).code === "invalid_lease");
    await assert.rejects(broker.call({ ...valid, generation: 2 }, "state.read", { key: "probe" }), error => (error as { code: string }).code === "stale_generation");
  } finally {
    adapter.thaw();
    for (const session of sessions) await session.dispose();
    for (const off of detach) off();
    await rm(cwd, { recursive: true, force: true });
  }
});
