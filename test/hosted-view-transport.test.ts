import test from "node:test";
import assert from "node:assert/strict";
import { HostedViewPoller } from "../src/host/client/hosted/view-poller.ts";
import { hostedApi } from "../src/host/server/plugins/hosted/routes.ts";
import type { HostedBridgeHandlers } from "../src/host/server/plugins/hosted/routes.ts";
import { HostedViewCoordinator } from "../src/host/server/plugins/hosted/views.ts";
import type { HostedViewInput, HostedViewReply } from "../src/contracts/hosted-plugins.ts";
const identity = { pluginId: "plugin", sessionId: "session", generation: 1, mountId: "one" };
const scope = { ownerId: "owner", workspaceId: "workspace", sessionId: "session" };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("aggregate route authenticates each capability, isolates failures, never holds idle sockets or admits writes", async () => {
  const c = new HostedViewCoordinator("plugin", 1, 20_000, 50);
  const { viewToken } = await c.handle({ ...identity, operation: "register", kind: "tool" }, scope);
  const seen: Record<string, unknown>[] = [];
  const host = { views: async (input: Record<string, unknown>) => { seen.push(input); return c.handle(input as unknown as HostedViewInput, scope); } } as HostedBridgeHandlers;
  const poll = { ...identity, viewToken, operation: "poll", after: 0 };
  const before = Date.now();
  const result = await hostedApi(host, "/api/hosted-plugins/views", { operation: "pollMany", views: [poll, { ...poll, viewToken: "other-window" }] }) as any;
  assert.ok(Date.now() - before < 1000, "aggregate must not enter the 20-second waiter");
  assert.deepEqual(result.replies[0].reply.commands, []); assert.equal(result.replies[1].failure.status, 409);
  assert.ok(seen.every(x => x.immediate === true));
  await assert.rejects(hostedApi(host, "/api/hosted-plugins/views", { operation: "pollMany", views: [{ ...poll, operation: "change", dirty: false, busy: false }] }), /view polls/);
  await assert.rejects(hostedApi(host, "/api/hosted-plugins/views", { operation: "pollMany", views: Array(65).fill(poll) }), /view polls/);
  // Polling is not a flush acknowledgement and cannot reconcile dirty/unknown mounts.
  await assert.rejects(c.handle({ ...identity, viewToken, operation: "close" }, scope), /Dirty view/);
  assert.equal(c.canSwitch(), false); c.dispose();
});

test("poller batches 130 views fairly in 64-member chunks, one request at a time, with idle cadence and no empty polling", async () => {
  let active = 0, peak = 0, calls = 0; const batches: number[] = [], times: number[] = [];
  const poller = new HostedViewPoller(30, async views => {
    active++; peak = Math.max(peak, active); calls++; times.push(Date.now()); batches.push(views.length);
    await sleep(2); active--;
    return { replies: views.map(v => ({ reply: { viewToken: v.viewToken, commands: [] } })) };
  });
  const removes = Array.from({ length: 130 }, (_, i) => poller.add({ input: () => ({ ...identity, viewToken: String(i), operation: "poll", after: 0 }), accept: async () => {}, fail: assert.fail }));
  await sleep(90); removes.forEach(remove => remove()); await sleep(10);
  assert.equal(peak, 1); assert.deepEqual(batches.slice(0, 3), [64, 64, 2]);
  assert.ok(times[3]! - times[2]! >= 25, "idle gap is bounded, not a busy loop");
  const stopped = calls; await sleep(50); assert.equal(calls, stopped);
});

test("one stale capability stops only its reader; network failure stops the remaining readers without implicit retries", async () => {
  let calls = 0; const received: string[] = [], failed: string[] = [];
  const poller = new HostedViewPoller(5, async views => {
    if (++calls > 1) throw new Error("offline");
    return { replies: views.map(v => v.viewToken === "bad" ? { failure: { status: 409, body: { error: "stale" } } } : { reply: { viewToken: v.viewToken, commands: [] } }) };
  });
  for (const token of ["good", "bad"]) poller.add({ input: () => ({ ...identity, viewToken: token, operation: "poll", after: 0 }), accept: async () => { received.push(token); }, fail: () => { failed.push(token); } });
  await sleep(70); assert.deepEqual(received, ["good"]); assert.deepEqual(failed, ["bad", "good"]); assert.equal(calls, 2);
});

test("late aggregate reply cannot operate on an unmounted view", async () => {
  let release!: (value: { replies: { reply: HostedViewReply }[] }) => void;
  const pending = new Promise<{ replies: { reply: HostedViewReply }[] }>(resolve => { release = resolve; });
  const poller = new HostedViewPoller(5, () => pending);
  let accepted = false;
  const remove = poller.add({ input: () => ({ ...identity, viewToken: "token", operation: "poll", after: 0 }), accept: async () => { accepted = true; }, fail: assert.fail });
  await sleep(10); remove(); release({ replies: [{ reply: { viewToken: "token", commands: [{ id: 1, type: "freeze", generation: 1 }] } }] });
  await sleep(10); assert.equal(accepted, false);
});
