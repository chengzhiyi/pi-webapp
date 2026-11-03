import test from "node:test";
import assert from "node:assert/strict";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { BackgroundTasksActivityProvider } from "../src/plugins/builtin/activity/server/background-tasks.ts";
import { SubagentsActivityProvider } from "../src/plugins/builtin/activity/server/subagents.ts";
import { SessionActivity } from "../src/plugins/builtin/activity/server/session-activity.ts";

const BG_REQUEST = "pi-background-tasks:host:request:v1";
const BG_RESPONSE = "pi-background-tasks:host:response:v1";
const BG_CHANGED = "pi-background-tasks:host:changed:v1";
const SUBAGENT_REQUEST = "subagents:rpc:v1:request";

interface RequestFrame { request_id?: string; requestId?: string; operation?: string; method?: string; payload?: Record<string, unknown>; params?: Record<string, unknown> }
const taskView = {
  task: { id: "task-1", name: "Unit tests", command: "npm test", status: "running", outputPath: ".pi/tasks/task-1.log", cwd: "/work", startTime: 1000, bytesWritten: 12, isAgent: false, surviveReload: false, notified: false, notifyOnCompletion: true, triggerOnCompletion: true },
  kind: "shell", seen: false, canRerun: true, canReadResult: false, truncatedFields: [],
};
const activation = { activationId: "activation-1", sessionId: "session-1", revision: 1, observedAt: 2000, counts: { running: 1, completed: 0, failed: 0, killed: 0, unseenCompleted: 0, unseenFailed: 0, unseenKilled: 0, total: 1 } };

test("background activity uses the native host lease and maps detail and controls", async () => {
  const bus = createEventBus();
  const operations: string[] = [];
  bus.on(BG_REQUEST, value => {
    const request = value as RequestFrame;
    const operation = request.operation!;
    operations.push(operation);
    let result: unknown;
    if (operation === "subscribe") result = { ...activation, leaseId: "lease-1" };
    else if (operation === "list") result = { ...activation, tasks: [taskView], nextCursor: null };
    else if (operation === "detail") result = { task: { ...taskView, seen: true } };
    else if (operation === "logs") result = { task: taskView.task, path: taskView.task.outputPath, text: "4 passing", tail: true, maxBytes: 65536, bytesRead: 9, totalBytes: 9, windowStart: 0, windowEnd: 9, truncated: false, bytesWritten: 9 };
    else if (operation === "stop") result = { task: { ...taskView.task, status: "killed" }, alreadyTerminal: false };
    else if (operation === "rerun") result = { sourceTaskId: "task-1", task: { ...taskView.task, id: "task-2" } };
    bus.emit(BG_RESPONSE, { schema_version: "pi-background-tasks.host-response.v1", request_id: request.request_id, operation, ok: true, result });
  });
  const provider = new BackgroundTasksActivityProvider(bus, "session-1", () => {});
  try {
    const snapshot = await provider.read();
    assert.equal(snapshot.provider.available, true);
    assert.equal(snapshot.items[0]?.title, "Unit tests");
    assert.equal(snapshot.items[0]?.status, "running");
    assert.equal(snapshot.items[0]?.canRerun, true);
    const detail = await provider.detail("task-1");
    assert.equal(detail.text, "4 passing");
    assert.equal(detail.outputPath, taskView.task.outputPath);
    await provider.stop("task-1");
    await provider.rerun("task-1");
    assert.deepEqual(operations, ["subscribe", "list", "detail", "logs", "stop", "rerun"]);
  } finally { provider.close(); bus.clear(); }
});

test("subagent activity merges async runs with foreground fleet entries", async () => {
  const bus = createEventBus();
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  bus.on(SUBAGENT_REQUEST, value => {
    const request = value as RequestFrame;
    const method = request.method!;
    const params = request.params ?? {};
    calls.push({ method, params });
    let data: unknown;
    if (method === "status" && !params.id) data = {
      text: "status",
      asyncSnapshot: { runs: [
        { id: "run-1", kind: "workflow", label: "Review MR", state: "running", startedAt: 1000, children: [{ id: "child-1", kind: "step", label: "Reviewer", state: "running", startedAt: 1100, agent: "reviewer", model: "kimi/k2", activity: { currentTool: "read" } }] },
        { id: "run-2", kind: "subagent", label: "Scout", state: "complete", startedAt: 500, endedAt: 900 },
      ] },
      fleet: { entries: [
        { key: "fleet-1", agent: "reviewer", startedAt: 1100, model: "kimi/k2", tokens: { input: 900, output: 300, total: 1200 } },
        { key: "fleet-2", agent: "worker", role: "Foreground worker", goal: "Checking types", startedAt: 1200, tokens: { input: 100, output: 50, total: 150 } },
      ] },
    };
    else if (method === "status") data = { text: "child transcript", truncated: true };
    else data = { runId: params.id, state: "stopping" };
    bus.emit(`subagents:rpc:v1:reply:${request.requestId}`, { version: 1, requestId: request.requestId, method, success: true, data });
  });
  const provider = new SubagentsActivityProvider(bus, () => {});
  try {
    const snapshot = await provider.read();
    assert.equal(snapshot.items.length, 3);
    const workflow = snapshot.items.find(item => item.id === "run-1");
    assert.equal(workflow?.kind, "workflow");
    assert.equal(workflow?.currentAction, "read");
    assert.equal(workflow?.model, "kimi/k2");
    assert.equal(workflow?.tokens, 1200);
    assert.equal(workflow?.canStop, true);
    assert.equal(snapshot.items.find(item => item.id === "run-2")?.status, "completed");
    assert.equal(snapshot.items.find(item => item.id === "fleet:fleet-2")?.canStop, false);
    const detail = await provider.detail("run-1");
    assert.equal(detail.text, "child transcript");
    assert.equal(detail.truncated, true);
    await provider.stop("run-1");
    assert.deepEqual(calls.at(-1), { method: "stop", params: { id: "run-1" } });
  } finally { provider.close(); bus.clear(); }
});

test("session activity publishes provider invalidations only to live subscribers", async () => {
  const bus = createEventBus();
  let lists = 0;
  bus.on(BG_REQUEST, value => {
    const request = value as RequestFrame;
    const operation = request.operation!;
    if (operation === "list") lists++;
    bus.emit(BG_RESPONSE, { schema_version: "pi-background-tasks.host-response.v1", request_id: request.request_id, operation, ok: true, result: operation === "subscribe" ? { ...activation, leaseId: "lease-1" } : { ...activation, tasks: [], nextCursor: null } });
  });
  bus.on(SUBAGENT_REQUEST, value => {
    const request = value as RequestFrame;
    bus.emit(`subagents:rpc:v1:reply:${request.requestId}`, { version: 1, requestId: request.requestId, method: request.method, success: true, data: { text: "idle", asyncSnapshot: { runs: [] }, fleet: { entries: [] } } });
  });
  const activity = new SessionActivity(bus, "session-1");
  try {
    bus.emit(BG_CHANGED, { kind: "changed", sessionId: "session-1", activationId: "activation-1" });
    await new Promise(resolve => setTimeout(resolve, 130));
    assert.equal(lists, 0);
    let revisions = 0;
    let unsubscribe = () => {};
    await new Promise<void>(resolve => {
      unsubscribe = activity.subscribe(() => { revisions++; resolve(); });
    });
    assert.equal(revisions, 1);
    bus.emit(BG_CHANGED, { kind: "changed", sessionId: "session-1", activationId: "activation-1" });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(lists, 2);
    assert.equal(revisions, 1); // Empty, unchanged snapshots are not rebroadcast.
    unsubscribe();
    let closed = false;
    activity.subscribe(value => { closed = value.closed === true; });
    activity.close();
    assert.equal(closed, true, "runtime replacement tells attached browsers to reconnect");
  } finally { activity.close(); bus.clear(); }
});
