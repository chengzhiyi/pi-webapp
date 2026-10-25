import { test } from "node:test";
import assert from "node:assert/strict";
import { HostedViewCoordinator } from "../src/host/server/plugins/hosted/views.ts";
import { FrameRegistry, type FrameAdapter } from "../src/host/client/hosted/frame-adapter.ts";
import { retainHostedCards } from "../src/host/client/hosted/catalog.ts";
import type { HostedPluginCard, HostedViewIdentity, HostedViewInput } from "../src/contracts/hosted-plugins.ts";
test("pending updates preserve old frame identity and undo; only committed generation remounts", () => {
  const old: HostedPluginCard = { pluginId: "plugin", name: "Plugin", official: false, installed: true, enabled: true, generation: 1, phase: "active", documentUrl: "/frame.html", controllerUrl: "/frame.html", contribution: { entry: { kind: "workspace", label: "Plugin", description: { zh: "插件", en: "Plugin" } }, panels: ["workspace", "editor"], artifactTools: [], toolViews: [], panelAlias: { prefix: "p:", kind: "editor", title: "Plugin" } } };
  const previous = [old];
  assert.equal(retainHostedCards([{ ...old, pendingVersion: "2", phase: "pending" }], previous), previous);
  assert.notEqual(retainHostedCards([{ ...old, generation: 2 }], previous)[0], old);
  assert.equal(retainHostedCards([{ ...old, enabled: false }], previous).length, 0);
});
const scope = { ownerId: "user", workspaceId: "workspace", sessionId: "session" };
const identity = (mountId: string): HostedViewIdentity => ({ sessionId: "session", pluginId: "plugin", mountId, generation: 1 });
async function register(coordinator: HostedViewCoordinator, id: string, kind: "tool" | "editor" = "tool") {
  const base = identity(id);
  const { viewToken } = await coordinator.handle({ ...base, operation: "register", kind }, scope);
  const request = Object.assign((input: object, auth = scope) => coordinator.handle({ ...base, viewToken, ...input } as HostedViewInput, auth), { viewToken });
  await request({ operation: "change", dirty: false, busy: false });
  return request;
}
test("every frame flushes even when another rejects; failed ready and offline preserve send failure", async () => {
  const registry = new FrameRegistry(); const called: string[] = [];
  for (const id of ["controller", "hidden-editor", "tool"]) registry.add({ identity: identity(id), ready: Promise.resolve(), adapter: { async call() { called.push(id); if (id === "hidden-editor") throw new Error("IME busy"); } } as unknown as FrameAdapter });
  await assert.rejects(registry.flush("session"), /IME busy/);
  assert.deepEqual(called.sort(), ["controller", "hidden-editor", "tool"]);
  const offline = new FrameRegistry();
  offline.add({ identity: identity("offline"), ready: Promise.reject(new Error("offline")), adapter: {} as FrameAdapter });
  await assert.rejects(offline.flush("session"), /offline/);
});
test("mount changes during flush reject rather than silently bypassing a new editor", async () => {
  const registry = new FrameRegistry();
  registry.add({ identity: identity("one"), ready: Promise.resolve(), adapter: { async call() { registry.add({ identity: identity("new"), ready: Promise.resolve(), adapter: {} as FrameAdapter }); } } as unknown as FrameAdapter });
  await assert.rejects(registry.flush("session"), /views changed/);
});
test("tab close retires only its still-mounted scoped frame; refusal cannot manufacture a close", async () => {
  const registry = new FrameRegistry(), retired: string[] = [];
  const editor = {} as HTMLIFrameElement, tool = {} as HTMLIFrameElement;
  for (const [name, frame] of [["editor", editor], ["tool", tool]] as const) registry.add({ identity: identity(name), ready: Promise.resolve(), adapter: { frame } as FrameAdapter, retire: async () => { retired.push(name); } });
  registry.add({ identity: { ...identity("other-session"), sessionId: "other" }, ready: Promise.resolve(), adapter: { frame: editor } as FrameAdapter, retire: async () => { assert.fail("wrong scope"); } });
  const root = { contains: (frame: unknown) => frame === editor } as Element;
  await registry.retireWithin("session", root);
  assert.deepEqual(retired, ["editor"]);
  registry.add({ identity: identity("busy"), ready: Promise.resolve(), adapter: { frame: editor } as FrameAdapter, retire: async () => { throw new Error("unacknowledged edits"); } });
  await assert.rejects(registry.retireWithin("session", root), /unacknowledged edits/);
});

test("editor updates wait by default; explicit immediate mode still refuses busy views", async () => {
  const coordinator = new HostedViewCoordinator("plugin", 1, 50, 40);
  const editor = await register(coordinator, "editor", "editor");
  assert.equal(coordinator.canSwitch(), false);
  coordinator.allowImmediateReopen(true); assert.equal(coordinator.canSwitch(), true);
  await editor({ operation: "change", dirty: true, busy: true });
  assert.equal(coordinator.canSwitch(), false);
  await assert.rejects(coordinator.freeze(), /Close editors/);
  await assert.rejects(editor({ operation: "close" }), /Dirty view/);
  coordinator.dispose();
});
test("a newly enabled realm cannot shut down before real readiness; ready still requires a freeze ack", async () => {
  const coordinator = new HostedViewCoordinator("plugin", 1, 50, 100);
  const base = identity("new-final-mount");
  const { viewToken } = await coordinator.handle({ ...base, operation: "register", kind: "editor" }, scope);
  const request = (input: object) => coordinator.handle({ ...base, viewToken, ...input } as HostedViewInput, scope);
  coordinator.allowImmediateReopen(true); // Same editor-close permission as host exit, not readiness.
  assert.equal(coordinator.canSwitch(), false);
  await assert.rejects(coordinator.freeze(), /Close editors/);
  assert.deepEqual((await request({ operation: "poll", after: 0, immediate: true })).commands, []);
  await request({ operation: "change", dirty: false, busy: false });
  const frozen = coordinator.freeze();
  let completed = false; void frozen.then(() => { completed = true; });
  const command = (await request({ operation: "poll", after: 0, immediate: true })).commands[0]!;
  assert.equal(command.type, "freeze"); assert.equal(completed, false);
  await request({ operation: "ack", commandId: command.id, ok: true }); await frozen;
  assert.equal(completed, true);
  coordinator.dispose();
});
test("all-window barrier requires every ack, fences generation, rejects scope and freezes new mounts", async () => {
  const coordinator = new HostedViewCoordinator("plugin", 1, 50, 100);
  const one = await register(coordinator, "window-one"); const two = await register(coordinator, "window-two");
  const action = { ...identity("window-one"), action: "sync", viewToken: one.viewToken };
  assert.equal(coordinator.authorizesFlush(action, scope), false);
  const frozen = coordinator.freeze();
  assert.equal(coordinator.authorizesFlush(action, scope), true);
  assert.equal(coordinator.authorizesFlush(action, { ...scope, workspaceId: "other" }), false);
  assert.equal(coordinator.authorizesFlush({ ...action, generation: 0 }, scope), false);
  await assert.rejects(register(coordinator, "new"), /switching/);
  const command = (await one({ operation: "poll", after: 0 })).commands[0]!;
  await one({ operation: "ack", commandId: command.id, ok: true });
  assert.equal(coordinator.authorizesFlush(action, scope), false);
  await assert.rejects(coordinator.committed({ generation: 2 }), /before all views/);
  await two({ operation: "ack", commandId: command.id, ok: true }); await frozen;
  await coordinator.committed({ generation: 2 });
  await assert.rejects(register(coordinator, "stale"), /switching/);
  await assert.rejects(one({ operation: "close" }, { ...scope, ownerId: "other" }), /capability/);
  assert.equal((await one({ operation: "poll", after: command.id })).commands[0]!.type, "committed");
  coordinator.dispose();
});
test("missing ack times out old-preserving; disconnected dirty views never expire", async () => {
  const coordinator = new HostedViewCoordinator("plugin", 1, 50, 25);
  const one = await register(coordinator, "offline");
  await assert.rejects(coordinator.freeze(), /Missing view flush/);
  const commands = (await one({ operation: "poll", after: 0 })).commands;
  assert.equal(commands.at(-1)!.type, "resume");
  await one({ operation: "change", dirty: true, busy: true });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(coordinator.canSwitch(), false);
  await assert.rejects(one({ operation: "close" }), /Dirty view/);
  coordinator.dispose();
});
test("negative acknowledgement resumes old generation and bounded poll does not spin", async () => {
  const coordinator = new HostedViewCoordinator("plugin", 1, 50, 100);
  const one = await register(coordinator, "busy");
  const before = Date.now(); assert.equal((await one({ operation: "poll", after: 0 })).commands.length, 0); assert.ok(Date.now() - before >= 40);
  const frozen = coordinator.freeze(); const expected = assert.rejects(frozen, /dragging/);
  const command = (await one({ operation: "poll", after: 0 })).commands[0]!;
  await one({ operation: "ack", commandId: command.id, ok: false, error: "dragging" }); await expected;
  assert.equal(coordinator.canSwitch(), true); coordinator.dispose();
});
