import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startBridge } from "../src/host/server/transport/bridge.ts";
import { EditablePromptQueue } from "../src/host/server/sessions/editable-prompt-queue.ts";

test("queue edits/deletes/steering authenticate, version and address exact session occurrences", async () => {
  const queue = new EditablePromptQueue(); queue.enqueue("same"); queue.enqueue("same");
  let reviewing = false, delivered = 0;
  const bridge = await startBridge({
    snapshot: () => ({ schemaVersion: 1, sessionId: "a", cwd: "/tmp", name: "Chat", model: null, thinkingLevel: null, thinkingLevels: [], idle: false, contextUsage: null, messages: [], pluginEntries: [], queuedPrompts: queue.view(), interactions: reviewing ? [{ requestId: "review", sessionId: "a", pluginId: "plan", kind: "review", data: {} }] : [] }),
    models: () => [], async setModel() {}, async setThinkingLevel() {},
    config: () => ({ projectTrusted: true, global: { packages: [], extensions: [], skills: [] }, project: { packages: [], extensions: [], skills: [] }, installed: { packages: [], extensions: [], skills: [] } }),
    async updateConfig() { return this.config(); }, send() {}, abort() {}, async newSession() {},
    async workspaces() { return { items: [], activeId: null, sessions: [] }; }, async addWorkspace() {}, async selectWorkspace() {}, async newSessionInWorkspace() {}, async removeWorkspace() {}, async selectSession() {},
    async updateQueuedPrompt(_sessionId, id, revision, action) { await queue.update(id, revision, action, async () => { delivered++; }); },
  }, fileURLToPath(new URL("../web/dist/", import.meta.url)));
  try {
    const url = new URL(bridge.url);
    const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, "Content-Type": "application/json" };
    const [first, second] = queue.view();
    const post = (body: object, chosen = headers) => fetch(`${url.origin}/api/prompt-queue`, { method: "POST", headers: chosen, body: JSON.stringify({ sessionId: "a", id: first!.id, revision: first!.revision, action: { kind: "remove" }, ...body }) });
    assert.equal((await post({}, { ...headers, Authorization: "Bearer wrong" })).status, 401);
    assert.equal((await post({}, { ...headers, Origin: "https://example.com" })).status, 403);
    assert.equal((await post({ sessionId: "other" })).status, 409);
    for (const fields of [{ revision: 0 }, { revision: 1.5 }, { action: {} }, { action: null }, { action: { kind: "edit", text: 1 } }]) assert.equal((await post(fields)).status, 400);
    assert.equal((await post({ action: { kind: "edit", text: "edited" } })).status, 202);
    assert.equal((await post({})).status, 409, "a stale revision cannot delete newer edits");
    reviewing = true;
    const edited = queue.view()[0]!;
    assert.equal((await post({ revision: edited.revision, action: { kind: "steer" } })).status, 409);
    assert.equal(delivered, 0);
    assert.equal((await post({ id: second!.id, revision: second!.revision })).status, 202, "safe deletion stays available during approval");
    assert.deepEqual(queue.view().map(item => item.text), ["edited"]);
    reviewing = false;
    assert.equal((await post({ revision: edited.revision, action: { kind: "steer" } })).status, 202);
    assert.equal(delivered, 1);
    assert.equal((await post({ revision: edited.revision, action: { kind: "steer" } })).status, 409);
  } finally { await bridge.close(); }
});
