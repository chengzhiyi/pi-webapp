import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { HostedAgentAdapter, type HostedAgentPolicy } from "../src/host/server/plugins/hosted/agent-adapter.ts";

const tool = { name: "hosted_policy", label: "Policy", action: "policy.run", description: "Policy probe", readonly: false,
  parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } };

test("real SDK/TUI mount: direct + codemode/nested admission, plan/allowlist/disabled guards, ownership and exact validation", { timeout: 15000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hosted-policy-"));
  let policy: HostedAgentPolicy = { enabled: true }, calls = 0;
  let pi!: ExtensionAPI, foreignPi!: ExtensionAPI;
  const adapter = new HostedAgentAdapter({ policy: () => policy, invoke: async () => { calls++; return { content: [{ type: "text", text: "allowed" }], details: undefined }; } });
  await adapter.verifyCompatibility();
  const manager = SessionManager.inMemory(cwd);
  const scope = { cwd, workspaceId: "trusted", sessionId: manager.getSessionId() };
  const outcomes: boolean[] = [];
  const nested: ToolDefinition = { name: "nested_probe", label: "Nested", description: "Call a hosted tool as codemode does", parameters: { type: "object", properties: {} } as ToolDefinition["parameters"],
    execute: async (_id, _args, _signal, _update, ctx) => {
      const outcome = await ctx.executeTool("hosted_policy", { value: "nested" }); outcomes.push(outcome.isError);
      return { content: [{ type: "text", text: JSON.stringify(outcome) }], details: undefined };
    } };
  const loader = new DefaultResourceLoader({ cwd, agentDir: join(cwd, "agent"), noExtensions: true, noSkills: true, noPromptTemplates: true, extensionFactories: [api => { foreignPi = api; }, api => {
    pi = api;
    api.on("session_start", () => { adapter.mountTui(api, scope); });
  }] });
  await loader.reload();
  const { session } = await createAgentSession({ cwd, sessionManager: manager, resourceLoader: loader, customTools: [nested] });
  try {
    await session.bindExtensions({ mode: "print" });
    const model = session.modelRuntime.getModels("openai")[0]!;
    await session.modelRuntime.setRuntimeApiKey("openai", "fixture-no-network"); await session.setModel(model);
    const change = async (next: HostedAgentPolicy) => { await adapter.freeze(); policy = next; adapter.change("fixture", [tool]); adapter.thaw(); };
    const run = async (name: string, args: Record<string, string | number> = {}) => {
      let stage = 0;
      session.agent.streamFunction = async model => {
        const first = stage++ === 0;
        const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: first ? [{ type: "toolCall", id: `probe-${Date.now()}`, name, arguments: args }] : [{ type: "text", text: "done" }], stopReason: first ? "toolUse" : "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        const stream = createAssistantMessageEventStream(); stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: first ? "toolUse" : "stop", message }); stream.end(message); return stream;
      };
      await session.prompt("deterministic policy probe");
    };
    await change({ enabled: true }); await run("hosted_policy", { value: "direct" }); assert.equal(calls, 1);
    await run("hosted_policy", {}); assert.equal(calls, 1, "exact schema rejects bad input");
    await run("nested_probe"); assert.equal(outcomes.at(-1), true); assert.equal(calls, 1);
    await change({ enabled: true, exposure: "codemode", allowNested: true });
    assert.ok(!session.getActiveToolNames().includes("hosted_policy"));
    await run("nested_probe"); assert.equal(outcomes.at(-1), false); assert.equal(calls, 2);
    await run("hosted_policy", { value: "undeclared-direct" }); assert.equal(calls, 2);
    await change({ enabled: false, exposure: "codemode", allowNested: true });
    pi.setActiveTools(["nested_probe", "hosted_policy"]); await run("nested_probe"); assert.equal(outcomes.at(-1), true); assert.equal(calls, 2);
    await run("hosted_policy", { value: "disabled-direct" }); assert.equal(calls, 2);
    await change({ enabled: true, allowNested: true, planMode: true }); await run("nested_probe"); assert.equal(outcomes.at(-1), true); assert.equal(calls, 2);
    await change({ enabled: true, allowNested: true, allowlist: [] }); await run("nested_probe"); assert.equal(outcomes.at(-1), true); assert.equal(calls, 2);
    await assert.rejects(adapter.invokeAction("fixture", scope, "arbitrary", {}), /policy/);
    await change({ enabled: true, allowNested: true });
    policy = { enabled: false }; // Execution-time policy still guards a previously published definition.
    await run("hosted_policy", { value: "policy-changed" }); assert.equal(calls, 2);
    await run("nested_probe"); assert.equal(outcomes.at(-1), true); assert.equal(calls, 2);
    // Simulate a different extension taking the name after our original registration.
    const foreign: ToolDefinition = { name: tool.name, label: "Foreign", description: "Unrelated owner", parameters: { type: "object", properties: {} } as ToolDefinition["parameters"], execute: nested.execute };
    foreignPi.registerTool(foreign);
    await adapter.freeze();
    assert.throws(() => adapter.change("fixture", [tool]), /another extension or builtin/);
    assert.throws(() => adapter.change("fixture", []), /another extension or builtin/, "hiding must not overwrite a foreign owner either");
    adapter.thaw();
    assert.equal(session.getAllTools().find(item => item.name === tool.name)?.description, "Unrelated owner");
  } finally { adapter.thaw(); await session.dispose(); await rm(cwd, { recursive: true, force: true }); }
});
