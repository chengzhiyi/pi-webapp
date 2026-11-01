import assert from "node:assert/strict";
import test from "node:test";
import { ExecuteApprovals } from "../src/host/server/plugins/hosted/capabilities/execute-approvals.ts";
import { hostedApi } from "../src/host/server/plugins/hosted/routes.ts";

test("authorize queues a visible request, grants only after decide, and denial has a cooldown", async () => {
  let now = 0, changes = 0;
  const a = new ExecuteApprovals({ now: () => now, changed: () => { changes++; }, describe: id => `title:${id}` });
  await assert.rejects(a.authorize("p", "s1"), { code: "approval_required", status: 409 });
  await assert.rejects(a.authorize("p", "s1"), { code: "approval_required" });
  assert.deepEqual(a.pending().map(x => x.title), ["title:s1"]); assert.equal(changes, 1, "repeat polls do not re-notify");
  await assert.rejects(a.authorize("other", "s1"), { code: "execute_denied" }, "another plugin cannot ride the request");
  a.decide(a.pending()[0]!.id, false);
  await assert.rejects(a.authorize("p", "s1"), { code: "execute_denied" });
  now = 61_000;
  await assert.rejects(a.authorize("p", "s1"), { code: "approval_required" }, "asks again after the cooldown");
  a.decide(a.pending()[0]!.id, true);
  assert.equal(await a.authorize("p", "s1"), true);
  assert.throws(() => a.decide("00000000-0000-0000-0000-000000000000", true), { code: "unknown_approval" });
  a.forget("s1");
  await assert.rejects(a.authorize("p", "s1"), { code: "approval_required" });
});
test("approval route validates input and is fenced while draining", async () => {
  const decisions: Array<[string, boolean]> = [];
  const host = { inventory: async () => ({}), manage: async () => ({}), action: async () => ({}), views: async () => ({}), asset: async () => null, decide: (id: string, allow: boolean) => { decisions.push([id, allow]); return { ok: true }; } };
  const id = "11111111-1111-1111-1111-111111111111";
  assert.deepEqual(await hostedApi(host, "/api/hosted-plugins/approvals", { id, decision: "allow" }), { ok: true });
  assert.deepEqual(decisions, [[id, true]]);
  for (const bad of [{ id: "x", decision: "allow" }, { id, decision: "yes" }, {}]) await assert.rejects(hostedApi(host, "/api/hosted-plugins/approvals", bad), { code: "invalid_input" });
  await assert.rejects(hostedApi(host, "/api/hosted-plugins/approvals", { id, decision: "allow" }, { draining: true }), { code: "host_restarting" });
  await assert.rejects(hostedApi({ ...host, decide: undefined }, "/api/hosted-plugins/approvals", { id, decision: "allow" }), { code: "hosted_unavailable" });
});
