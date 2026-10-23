import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTick } from "node:timers/promises";
import { EditablePromptQueue } from "../src/host/server/sessions/editable-prompt-queue.ts";

test("queue occurrences use stable IDs and revisions, including identical text", async () => {
  const queue = new EditablePromptQueue();
  queue.enqueue("same"); queue.enqueue("same");
  const [first, second] = queue.view();
  assert.notEqual(first!.id, second!.id);
  await queue.update(first!.id, first!.revision, { kind: "edit", text: "changed" }, async () => {});
  await assert.rejects(queue.update(first!.id, first!.revision, { kind: "remove" }, async () => {}), /已变化/);
  await queue.update(second!.id, second!.revision, { kind: "remove" }, async () => {});
  assert.deepEqual(queue.view().map(item => item.text), ["changed"]);
});

test("editing preserves image payload and trusted attachment suffix without exposing either", async () => {
  const queue = new EditablePromptQueue();
  const path = `/tmp/pi-web/attachments/${"a".repeat(64)}/hint.png`;
  const images = [{ type: "image" as const, data: "base64-private", mimeType: "image/png" }];
  queue.enqueue(`old\n\n附件 "hint.png"：${path}`, images);
  const item = queue.view()[0]!;
  assert.equal(JSON.stringify(item).includes(path), false);
  assert.equal(JSON.stringify(item).includes("base64-private"), false);
  await queue.update(item.id, item.revision, { kind: "edit", text: "new" }, async () => {});
  const edited = queue.view()[0]!;
  assert.deepEqual(edited.attachments, [{ name: "hint.png", image: true }]);
  await queue.update(edited.id, edited.revision, { kind: "steer" }, async (text, received) => {
    assert.equal(text, `new\n\n附件 "hint.png"：${path}`); assert.deepEqual(received, images);
  });
  assert.equal(queue.length, 0);
});

test("in-flight handoff locks the exact row; failed sends restore it without automatic replay", async () => {
  const queue = new EditablePromptQueue(); queue.enqueue("work");
  const item = queue.view()[0]!;
  let fail!: (cause: Error) => void;
  const request = queue.update(item.id, item.revision, { kind: "steer" }, () => new Promise((_, reject) => { fail = reject; }));
  assert.equal(queue.view()[0]!.status, "sending");
  const current = queue.view()[0]!;
  await assert.rejects(queue.update(current.id, current.revision, { kind: "remove" }, async () => {}), /正在发送/);
  fail(new Error("rejected")); await assert.rejects(request, /rejected/);
  assert.equal(queue.view()[0]!.status, "queued");
  assert.equal(queue.view()[0]!.error, "rejected");
  let attempts = 0;
  queue.schedule(() => true, async () => { attempts++; });
  await nextTick(); assert.equal(attempts, 0);
});

test("automatic admission yields beyond settled notification, rechecks readiness and never starts after pause", async () => {
  const queue = new EditablePromptQueue(); queue.enqueue("one"); queue.enqueue("two");
  let ready = true;
  const sent: string[] = [];
  queue.schedule(() => ready, async text => { sent.push(text); });
  assert.equal(sent.length, 0);
  ready = false; await nextTick();
  assert.equal(queue.view()[0]!.status, "queued"); assert.equal(sent.length, 0);
  ready = true; queue.schedule(() => ready, async text => { sent.push(text); });
  await nextTick(); await nextTick();
  assert.deepEqual(sent, ["one", "two"]);
});

test("queue rejects slash edits, empty text, overflow and stale already-consumed IDs", async () => {
  const queue = new EditablePromptQueue(); queue.enqueue("safe");
  const item = queue.view()[0]!;
  for (const text of ["/new", " ", "a".repeat(32_001)]) await assert.rejects(queue.update(item.id, item.revision, { kind: "edit", text }, async () => {}), /无效/);
  await queue.update(item.id, item.revision, { kind: "remove" }, async () => {});
  await assert.rejects(queue.update(item.id, item.revision, { kind: "steer" }, async () => {}), /已变化/);
  for (let i = 0; i < 50; i++) queue.enqueue("bounded");
  assert.throws(() => queue.enqueue("extra"), /过多/);
});
