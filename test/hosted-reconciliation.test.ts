import { test } from "node:test";
import assert from "node:assert/strict";
import { HostedViewCoordinator } from "../src/host/server/plugins/hosted/views.ts";
import { FrameRegistry, type FrameAdapter } from "../src/host/client/hosted/frame-adapter.ts";
import type { HostedViewInput } from "../src/contracts/hosted-plugins.ts";

const scope = { ownerId: "owner", workspaceId: "workspace", sessionId: "session" };
const identity = { pluginId: "plugin", sessionId: "session", generation: 1, mountId: "lost-realm" };

test("lost unknown registration remains fail closed until individually confirmed; revoked actions cannot write", async () => {
  const c = new HostedViewCoordinator("plugin", 1, 50, 20);
  const { viewToken } = await c.handle({ ...identity, operation: "register", kind: "editor" }, scope);
  const request = (value: object, auth = scope) => c.handle({ ...identity, viewToken, ...value } as HostedViewInput, auth);
  c.allowImmediateReopen(true);
  await assert.rejects(c.freeze(), /Close editors/);
  await assert.rejects(request({ operation: "close" }), /Dirty view/);
  await assert.rejects(request({ operation: "discard" }), /confirmation/);
  await assert.rejects(request({ operation: "discard", confirmation: "discard-unconfirmed-edits" }, { ...scope, workspaceId: "other" }), /capability/);
  const action = { ...identity, viewToken, action: "sync" };
  const release = c.admitAction(action, scope);
  await assert.rejects(request({ operation: "discard", confirmation: "discard-unconfirmed-edits" }), /active barrier or action/);
  release();
  await request({ operation: "discard", confirmation: "discard-unconfirmed-edits" });
  assert.throws(() => c.admitAction(action, scope), /stale view action/);
  await assert.rejects(request({ operation: "change", dirty: false, busy: false }), /capability/);
  await c.freeze(); await c.committed({ generation: 2 });
  assert.throws(() => c.admitAction(action, scope), /stale view action/);
  c.dispose();
});

test("discard of one capability cannot retire another unknown view or manufacture a flush ack", async () => {
  const c = new HostedViewCoordinator("plugin", 1, 50, 20);
  const a = await c.handle({ ...identity, operation: "register", kind: "tool" }, scope);
  await c.handle({ ...identity, mountId: "another", operation: "register", kind: "tool" }, scope);
  await c.handle({ ...identity, viewToken: a.viewToken, operation: "discard", confirmation: "discard-unconfirmed-edits" }, scope);
  c.allowImmediateReopen(true);
  await assert.rejects(c.freeze(), /Close editors/);
  c.dispose();
});

test("a restarted host accepts explicit dismissal of an unknown record without acknowledging any live view", async () => {
  const c = new HostedViewCoordinator("plugin", 1, 50, 20);
  await c.handle({ ...identity, mountId: "still-live", operation: "register", kind: "editor" }, scope);
  const unknown = { ...identity, viewToken: "old-process-token" };
  assert.equal((await c.handle({ ...unknown, operation: "reconcile" }, scope)).recovery, "unconfirmed");
  await assert.rejects(c.handle({ ...unknown, operation: "discard" } as HostedViewInput, scope), /confirmation/);
  await c.handle({ ...unknown, operation: "discard", confirmation: "discard-unconfirmed-edits" }, scope);
  c.allowImmediateReopen(true);
  await assert.rejects(c.freeze(), /Close editors/);
  // Dismissal is a user decision, never a server checkpoint/close proof.
  assert.equal((await c.handle({ ...unknown, operation: "reconcile" }, scope)).recovery, "unconfirmed");
  c.dispose();
});

test("removed tool retirement keeps its registration/realm until real close; failure is retryable, sibling untouched", async () => {
  const registry = new FrameRegistry();
  let complete!: () => void, called = 0;
  const gate = new Promise<void>(resolve => { complete = resolve; });
  registry.add({ identity, ready: Promise.resolve(), adapter: {} as FrameAdapter, toolCallId: "call", retire: async () => { if (++called === 1) throw new Error("network: flush not confirmed"); await gate; } });
  registry.add({ identity: { ...identity, mountId: "sibling" }, ready: Promise.resolve(), adapter: {} as FrameAdapter, toolCallId: "sibling", retire: async () => { throw new Error("sibling must not retire"); } });
  await assert.rejects(registry.retireTools("session", ["call"]), /flush not confirmed/);
  assert.equal(registry.incarnation("session", "call"), 0);
  let finished = false;
  const retiring = registry.retireTools("session", ["call"]).then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false); assert.equal(registry.incarnation("session", "call"), 0);
  complete(); await retiring;
  assert.equal(registry.incarnation("session", "call"), 1);
  assert.equal(registry.incarnation("session", "sibling"), 0);
});
