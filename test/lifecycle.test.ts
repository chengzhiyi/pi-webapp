import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { LifecycleQueue, closeAgentSession } from "../extension/lifecycle.ts";

test("a stuck shutdown times out, invalidates once, and reports the failure", async () => {
  let emitted = 0; let disposed = 0;
  const errors: string[] = [];
  const session = { extensionRunner: { emit() { emitted++; return new Promise(() => {}); } }, dispose() { disposed++; } } as unknown as AgentSession;
  const first = closeAgentSession(session, "quit", message => errors.push(message), 5);
  await Promise.all([first, closeAgentSession(session, "quit", () => {}, 5)]);
  assert.equal(emitted, 1); assert.equal(disposed, 1);
  assert.match(errors[0]!, /timed out/);
});

test("lifecycle operations serialize and a rejected operation does not poison later work", async () => {
  const queue = new LifecycleQueue(); const calls: string[] = [];
  let finish!: () => void;
  const first = queue.run(async () => { calls.push("first"); await new Promise<void>(resolve => { finish = resolve; }); calls.push("end"); });
  const second = queue.run(async () => { calls.push("second"); throw new Error("failed"); });
  const third = queue.run(async () => { calls.push("third"); });
  const rejected = assert.rejects(second, /failed/);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ["first"]);
  finish(); await Promise.all([first, rejected, third]);
  assert.deepEqual(calls, ["first", "end", "second", "third"]);
});
