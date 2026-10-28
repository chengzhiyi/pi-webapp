import test from "node:test";
import assert from "node:assert/strict";
import { HostedViewCoordinator } from "../src/host/server/plugins/hosted/views.ts";
import type { HostedViewInput } from "../src/contracts/hosted-plugins.ts";

const scope = { ownerId: "owner", workspaceId: "workspace", sessionId: "session" };
const identity = { pluginId: "plugin", sessionId: "session", generation: 8, mountId: "prior-document" };

async function register(kind: "controller" | "editor" = "controller") {
  const coordinator = new HostedViewCoordinator("plugin", 8, 20, 30);
  const reply = await coordinator.handle({ ...identity, operation: "register", kind }, scope);
  const request = (operation: Record<string, unknown>, auth = scope) => coordinator.handle({ ...identity, viewToken: reply.viewToken, ...operation } as HostedViewInput, auth);
  return { coordinator, request, viewToken: reply.viewToken };
}

test("hidden controller has no authoring checkpoint and does not block a switch after its document disappears", async () => {
  const { coordinator, request } = await register();
  await request({ operation: "change", dirty: false, busy: true });
  assert.equal(coordinator.canSwitch(), true);
  await coordinator.freeze();
  await coordinator.committed({ generation: 9 });
  coordinator.dispose();
});

test("controller retirement is exact-capability idempotent and never interrupts an in-flight action", async () => {
  const { coordinator, request, viewToken } = await register();
  const release = coordinator.admitAction({ ...identity, viewToken, action: "initialize" }, scope);
  assert.equal(coordinator.canSwitch(), false);
  assert.equal((await request({ operation: "reconcile" })).recovery?.state, "active");
  release();
  assert.equal((await request({ operation: "reconcile" })).recovery?.state, "retired");
  assert.equal((await request({ operation: "reconcile" })).recovery?.state, "absent");
  assert.throws(() => coordinator.admitAction({ ...identity, viewToken, action: "sync" }, scope), /capability/);
  coordinator.dispose();
});

test("lost authoring view remains unconfirmed until explicitly retained for recovery, without a forged flush acknowledgement", async () => {
  const { coordinator, request, viewToken } = await register("editor");
  assert.equal((await request({ operation: "reconcile" })).recovery?.state, "unconfirmed");
  coordinator.allowImmediateReopen(true);
  await assert.rejects(coordinator.freeze(), /view|editor/i);
  await assert.rejects(request({ operation: "recover" }), /confirmation/);
  await assert.rejects(request({ operation: "recover", confirmation: "retain-unconfirmed-edits" }, { ...scope, workspaceId: "other" }), /capability/);
  const recovered = await request({ operation: "recover", confirmation: "retain-unconfirmed-edits" });
  assert.equal(recovered.recovery?.state, "retained");
  assert.equal(recovered.recovery?.dirty, true);
  assert.equal((await request({ operation: "reconcile" })).recovery?.state, "retained");
  assert.throws(() => coordinator.admitAction({ ...identity, viewToken, action: "sync" }, scope), /recover|capability/i);
  await coordinator.freeze();
  await coordinator.committed({ generation: 9 });
  assert.equal((await request({ operation: "reconcile" })).recovery?.state, "retained");
  coordinator.dispose();
});

test("initialization can be cancelled only before the frame acknowledges status or starts an action", async () => {
  const fresh = await register("editor");
  await fresh.request({ operation: "cancel-initialization" });
  await fresh.coordinator.freeze();
  fresh.coordinator.dispose();
  const initialized = await register("editor");
  await initialized.request({ operation: "change", dirty: false, busy: false });
  await assert.rejects(initialized.request({ operation: "cancel-initialization" }), /initialized/);
  initialized.coordinator.dispose();
});

test("refresh before registration response cancels the exact late initialization without leaking a controller", async () => {
  const coordinator = new HostedViewCoordinator("plugin", 8, 20, 30);
  const viewToken = "a7b74bae-cd09-462b-9faf-4a6bd4145af4";
  const retired = await coordinator.handle({ ...identity, viewToken, operation: "reconcile" }, scope);
  assert.equal(retired.recovery?.state, "absent");
  await assert.rejects(coordinator.handle({ ...identity, viewToken, operation: "register", kind: "controller" }, scope), /cancelled/);
  await coordinator.freeze(); coordinator.dispose();
});
