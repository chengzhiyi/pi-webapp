import test from "node:test";
import assert from "node:assert/strict";
import { HostedViewCoordinator } from "../src/host/server/plugins/hosted/views.ts";
import type { HostedViewInput } from "../src/contracts/hosted-plugins.ts";

test("a timed-out freeze identifies only the plugin views still missing save confirmation", async t => {
  const pluginId = "@test/drawing-plugin";
  const coordinator = new HostedViewCoordinator(pluginId, 1, 50, 30);
  t.after(() => coordinator.dispose());
  const scope = { ownerId: "owner", workspaceId: "workspace", sessionId: "lost-session" };
  const register = async (mountId: string) => {
    const identity = { pluginId, sessionId: scope.sessionId, generation: 1, mountId };
    const { viewToken } = await coordinator.handle({ ...identity, operation: "register", kind: "tool" }, scope);
    const request = (input: object) => coordinator.handle({ ...identity, viewToken, ...input } as HostedViewInput, scope);
    await request({ operation: "change", dirty: false, busy: false });
    return { request, viewToken };
  };
  const responding = await register("acknowledged-preview");
  const disconnected = await register("offline-preview");
  const frozen = coordinator.freeze();
  const rejected = assert.rejects(frozen, error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Missing view flush acknowledgement/);
    assert.match(error.message, /@test\/drawing-plugin/);
    assert.match(error.message, /lost-session/);
    assert.match(error.message, /tool/);
    assert.match(error.message, /offline-preview/);
    assert.doesNotMatch(error.message, /acknowledged-preview/);
    assert.doesNotMatch(error.message, new RegExp(disconnected.viewToken));
    return true;
  });
  const command = (await responding.request({ operation: "poll", after: 0, immediate: true })).commands[0]!;
  await responding.request({ operation: "ack", commandId: command.id, ok: true });
  await rejected;
  assert.equal((await disconnected.request({ operation: "poll", after: 0, immediate: true })).commands.at(-1)?.type, "resume");
  assert.equal((await disconnected.request({ operation: "reconcile" })).recovery?.state, "unconfirmed");
  await assert.rejects(coordinator.committed({ generation: 2 }), /before all views freeze/);
});
