import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { WorkspaceSessions } from "../src/host/server/sessions/workspace-sessions.ts";
import { diagramTools } from "../src/plugins/builtin/diagrams/server/tools.ts";
import { DiagramStore } from "../src/plugins/builtin/diagrams/server/store.ts";
import { architectureExample } from "../src/plugins/builtin/diagrams/contract/reference.ts";

test("retained SDK runtimes execute structured diagram tools through the normal model/tool loop", { timeout: 15000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-diagram-sdk-"));
  const prior = process.env.PI_CODING_AGENT_DIR, priorRoots = process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS;
  process.env.PI_CODING_AGENT_DIR = join(cwd, "agent"); process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS = "";
  const store = new DiagramStore();
  const tools = diagramTools(async (_pluginId, dir, session, action, input) => store.tool(dir, session, action, input));
  const workspaces = new WorkspaceSessions(() => {}, () => undefined, () => false, () => undefined, undefined, () => {}, tools);
  try {
    await workspaces.open(cwd, "new");
    const session = workspaces.session!;
    assert.ok(session.getAllTools().some(t => t.name === "diagram_create"));
    const model = session.modelRuntime.getModels("openai")[0]!;
    await session.modelRuntime.setRuntimeApiKey("openai", "fixture-no-network"); await session.setModel(model);
    let calls = 0;
    session.agent.streamFunction = async model => {
      const stage = ++calls, first = stage <= 2;
      const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        content: stage === 1 ? [{ type: "toolCall", id: "reference", name: "diagram_reference", arguments: {} }] : stage === 2 ? [{ type: "toolCall", id: "draw", name: "diagram_create", arguments: JSON.parse(JSON.stringify({ title: "SDK 分层架构", graph: architectureExample })) }] : [{ type: "text", text: "请在画布接受候选" }],
        stopReason: first ? "toolUse" : "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream(); stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message }); stream.end(message); return stream;
    };
    const settled = new Promise<void>(resolve => { const off = session.subscribe(event => { if (event.type === "agent_settled") { off(); resolve(); } }); });
    await workspaces.send("画一张分层架构图"); await settled;
    const drafts = store.list(workspaces.path!, session.sessionManager.getSessionId());
    assert.equal(calls, 3);
    assert.ok(workspaces.snapshot().messages.some(m => m.role === "tool" && m.toolName === "diagram_reference" && !m.isError));
    assert.equal(drafts.length, 1, JSON.stringify(workspaces.snapshot().messages)); assert.equal(drafts[0]?.pending, true);
    const result = workspaces.snapshot().messages.find(m => m.role === "tool" && m.toolName === "diagram_create");
    assert.ok(result && !result.isError);
    assert.equal(JSON.parse(result.blocks[0]!.text).status, "pending_canvas_acceptance");
    await workspaces.open(cwd, "new");
    assert.ok(workspaces.session!.getAllTools().some(t => t.name === "diagram_patch"));
    assert.equal(store.list(workspaces.path!, workspaces.session!.sessionManager.getSessionId()).length, 0);
  } finally {
    await workspaces.dispose();
    if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior;
    if (priorRoots === undefined) delete process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS; else process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS = priorRoots;
    await rm(cwd, { recursive: true, force: true });
  }
});
