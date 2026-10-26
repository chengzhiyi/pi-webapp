import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { WorkspaceSessions } from "../src/host/server/sessions/workspace-sessions.ts";
import { controlledReply } from "./helpers/controlled-reply.ts";
import { assertPromptDelivery } from "../src/host/server/sessions/prompt-delivery.ts";
import type { SessionView } from "../src/contracts/bridge-contract.ts";

const view: SessionView = { schemaVersion: 1, sessionId: "a", cwd: "/tmp", name: "A", model: null, thinkingLevel: null, thinkingLevels: [], idle: false, contextUsage: null, messages: [], pluginEntries: [] };

test("delivery guards preserve interaction gates and never queue slash commands", () => {
  assert.throws(() => assertPromptDelivery(view, "hello"), /选择引导或排队/);
  for (const delivery of ["steer", "followUp"] as const) {
    assert.doesNotThrow(() => assertPromptDelivery(view, "hello", delivery));
    assert.doesNotThrow(() => assertPromptDelivery({ ...view, idle: true }, "hello", delivery));
    assert.throws(() => assertPromptDelivery(view, " /new", delivery), /斜杠指令/);
    assert.throws(() => assertPromptDelivery({ ...view, interactions: [{ requestId: "review", sessionId: "a", pluginId: "plan", kind: "review", data: {} }] }, "hello", delivery), /交互或审批/);
  }
});

test("native SDK steering precedes follow-ups, preserves attachments and background queue identity", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-prompt-delivery-"));
  const savedAgent = process.env.PI_CODING_AGENT_DIR;
  const savedPlugins = process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS = "";
  const cwd = join(root, "workspace");
  await mkdir(cwd); await writeFile(join(cwd, "input.txt"), "tool context");
  const snapshots: SessionView[] = [];
  let whenDrained: (() => void) | undefined;
  const host = new WorkspaceSessions(event => {
    if (event.type === "snapshot") {
      snapshots.push(event.session);
      if (event.session.idle && event.session.queuedPrompts?.length === 0) whenDrained?.();
    }
  }, () => undefined);
  const drain = () => new Promise<void>(resolve => { whenDrained = resolve; });
  try {
    await host.open(cwd, "new");
    const session = host.session!;
    const id = host.snapshot().sessionId;
    const model = session.modelRuntime.getModels("openai")[0]!;
    await session.modelRuntime.setRuntimeApiKey("openai", "fixture-no-network");
    await session.setModel(model);
    const requests: string[] = [];
    let finishFirst!: () => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    session.agent.streamFunction = async (model, context) => {
      requests.push(JSON.stringify(context.messages));
      const first = requests.length === 1;
      const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: first ? [{ type: "toolCall", id: "read-input", name: "read", arguments: { path: "input.txt" } }] : [{ type: "text", text: `Reply ${requests.length}` }],
        stopReason: first ? "toolUse" : "stop", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
      const finish = () => { stream.push({ type: "done", reason: first ? "toolUse" : "stop", message }); stream.end(message); };
      if (first) { finishFirst = finish; started(); } else finish();
      return stream;
    };
    await host.send("Original task"); await ready;
    await assert.rejects(host.send("implicit busy send"), /选择引导或排队/);
    await host.send("Later one", [], undefined, "followUp");
    await host.send("Guide now", [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }], undefined, "steer");
    await host.send("Later two", [], undefined, "followUp");
    assert.deepEqual(host.snapshot().promptQueue, { steering: ["Guide now"], followUp: [] });
    assert.deepEqual(host.snapshot().queuedPrompts?.map(item => item.text), ["Later one", "Later two"]);
    const originalRow = host.snapshot().queuedPrompts![0]!;
    await host.updateQueuedPrompt(originalRow.id, originalRow.revision, { kind: "edit", text: "Later one edited" });
    await assert.rejects(host.updateQueuedPrompt(originalRow.id, originalRow.revision, { kind: "remove" }), /已变化/);
    const deleteRow = host.snapshot().queuedPrompts![1]!;
    await host.updateQueuedPrompt(deleteRow.id, deleteRow.revision, { kind: "remove" });
    await host.send("Later two", [], undefined, "followUp");
    assert.notEqual(host.snapshot().queuedPrompts![1]!.id, deleteRow.id);
    assert.equal(host.snapshot().messages.filter(message => message.role === "user").length, 1, "queued prompts are not transcript echoes");
    assert.ok(snapshots.some(snapshot => snapshot.promptQueue?.steering[0] === "Guide now"), "queue updates stream immediately");
    await host.open(cwd, "new");
    assert.deepEqual(host.snapshot().promptQueue, { steering: [], followUp: [] });
    await assert.rejects(host.updateQueuedPrompt(originalRow.id, originalRow.revision + 1, { kind: "remove" }), /已变化/);
    await host.open(cwd, { sessionId: id });
    assert.deepEqual(host.snapshot().queuedPrompts?.map(item => item.text), ["Later one edited", "Later two"]);
    const completed = drain(); finishFirst(); await completed;
    assert.equal(requests.length, 4);
    assert.match(requests[1]!, /Guide now/);
    assert.doesNotMatch(requests[1]!, /Later one/);
    assert.match(requests[2]!, /Later one/);
    assert.doesNotMatch(requests[2]!, /Later two/);
    assert.match(requests[3]!, /Later two/);
    assert.ok(host.snapshot().messages.some(message => message.role === "user" && message.blocks.some(block => block.kind === "image")));
    assert.deepEqual(host.snapshot().promptQueue, { steering: [], followUp: [] });
    assert.equal(host.snapshot().idle, true);
    // Explicit delivery from a stale busy UI must also work after the run settles.
    await host.send("Finished just before submit", [], undefined, "followUp");
    await session.waitForIdle();
    assert.match(requests.at(-1)!, /Finished just before submit/);
    const automaticStream = session.agent.streamFunction;
    const pausedReply = await controlledReply(session, "Partial progress before pausing");
    await host.send("Pause with queued work"); await pausedReply.ready;
    await host.send("Work after resume", [], undefined, "followUp");
    await host.stop();
    assert.equal(host.snapshot().paused, true);
    assert.deepEqual(host.snapshot().queuedPrompts?.map(item => item.text), ["Work after resume"], "pause retains pending prompts without silently executing them");
    const pausedRow = host.snapshot().queuedPrompts![0]!;
    await assert.rejects(host.updateQueuedPrompt(pausedRow.id, pausedRow.revision, { kind: "steer" }), /没有可引导/);
    session.agent.streamFunction = automaticStream;
    const resumed = drain(); await host.resume(); await resumed;
    assert.deepEqual(host.snapshot().promptQueue, { steering: [], followUp: [] });
    assert.equal(host.snapshot().paused, false);
  } finally {
    await host.dispose();
    if (savedAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgent;
    if (savedPlugins === undefined) delete process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS; else process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS = savedPlugins;
    await rm(root, { recursive: true, force: true });
  }
});
