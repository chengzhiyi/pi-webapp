import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { WorkspaceSessions } from "../extension/workspace-sessions.ts";
import { PAUSED_ENTRY } from "../extension/view.ts";
import type { DiagnosticFields } from "../shared/telemetry.ts";

test("real SDK tool failures are observed once and resumed tools use the new operation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tool-diagnostic-"));
  const savedAgent = process.env.PI_CODING_AGENT_DIR;
  const savedPlugins = process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS = "";
  const cwd = join(root, "workspace"); await mkdir(cwd);
  const events: DiagnosticFields[] = [];
  const breadcrumbs: { category: string; context: DiagnosticFields }[] = [];
  const host = new WorkspaceSessions(() => {}, () => undefined, () => false, (_cause, context) => { events.push(context); return "event"; }, {
    enabled: () => true, anonymize: () => "anonymous", breadcrumb: (category, context) => { breadcrumbs.push({ category, context }); },
  });
  try {
    await host.open(cwd, "new");
    const session = host.session!;
    const model = session.modelRuntime.getModels("openai")[0]!;
    await session.modelRuntime.setRuntimeApiKey("openai", "fixture-no-network");
    await session.setModel(model);
    let calls = 0;
    session.agent.streamFunction = async model => {
      const tool = calls++ % 2 === 0;
      const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: tool ? [{ type: "toolCall", id: `private-tool-${calls}`, name: "read", arguments: { path: join(cwd, "private-missing-file") } }] : [],
        stopReason: tool ? "toolUse" : "stop", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream(); stream.push({ type: "done", reason: tool ? "toolUse" : "stop", message }); stream.end(message); return stream;
    };
    await host.send("private user input", [], { requestId: "request-send", operationId: "operation-send" });
    await session.waitForIdle();
    assert.equal(events.length, 1);
    assert.equal(events[0]?.toolName, "read");
    assert.equal(events[0]?.errorCode, "ENOENT");
    assert.equal(events[0]?.level, "warning");
    assert.equal(events[0]?.originalStackAvailable, false);
    assert.equal(events[0]?.operationId, "operation-send");
    assert.equal(events[0]?.diagnosticSource, "tool_execution_end");
    session.sessionManager.appendCustomEntry(PAUSED_ENTRY);
    await host.resume({ requestId: "request-resume", operationId: "operation-resume" });
    await session.waitForIdle();
    assert.equal(events.length, 2);
    assert.equal(events[1]?.requestId, "request-resume");
    assert.equal(events[1]?.operationId, "operation-resume");
    for (const category of ["send", "resume", "agent_start", "tool_start", "tool_failed", "agent_end"]) assert.ok(breadcrumbs.some(item => item.category === category), category);
    const wire = JSON.stringify({ events, breadcrumbs });
    assert.ok(!wire.includes("private-missing-file")); assert.ok(!wire.includes("private user input")); assert.ok(!wire.includes("private-tool-"));
  } finally {
    await host.dispose();
    if (savedAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgent;
    if (savedPlugins === undefined) delete process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS; else process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS = savedPlugins;
    await rm(root, { recursive: true, force: true });
  }
});
