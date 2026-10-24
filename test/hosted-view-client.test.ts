import test from "node:test";
import assert from "node:assert/strict";
import { HostedViewClient } from "../src/host/client/hosted/view-client.ts";
import type { FrameAdapter } from "../src/host/client/hosted/frame-adapter.ts";
import { HostedViewPoller } from "../src/host/client/hosted/view-poller.ts";

test("committed frozen view closes once without a forbidden old-generation change", async t => {
  const originalFetch = globalThis.fetch, originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("http://localhost/") });
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation); else Reflect.deleteProperty(globalThis, "location");
  });
  const operations: string[] = [], frameCalls: string[] = [];
  globalThis.fetch = (async (_url, init) => {
    const input = JSON.parse(init!.body as string); operations.push(input.operation);
    if (input.operation === "change") throw new Error("Old generation may not change");
    return new Response(JSON.stringify({ viewToken: "token", commands: [], ...(input.operation === "pollMany" ? { replies: [{ reply: { viewToken: "token", commands: [{ id: 1, type: "freeze", generation: 7 }, { id: 2, type: "committed", generation: 8 }] } }] } : {}) }));
  }) as typeof fetch;
  const adapter = { call: async (method: string) => { frameCalls.push(method); return {}; } } as unknown as FrameAdapter;
  let reconnected!: () => void;
  const done = new Promise<void>(resolve => { reconnected = resolve; });
  const errors: unknown[] = [];
  const client = new HostedViewClient({ pluginId: "official", sessionId: "session", generation: 7, mountId: "editor" }, adapter, { kind: "editor", sessionId: "session", locale: "en", theme: "light" }, reconnected, error => errors.push(error));
  await client.start(); client.connecting(); client.listen(); await done;
  await Promise.all([client.close(), client.close()]);
  assert.deepEqual(operations, ["register", "pollMany", "ack", "ack", "close"]);
  assert.deepEqual(frameCalls, ["freeze"]); assert.deepEqual(errors, []);
});

test("destroyed/dirty realm cannot fabricate a freeze ack or a clean close through aggregate transport", async t => {
  const originalFetch = globalThis.fetch, originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("http://localhost/") });
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation); else Reflect.deleteProperty(globalThis, "location");
  });
  const writes: any[] = [];
  globalThis.fetch = (async (_url, init) => {
    const input = JSON.parse(init!.body as string); writes.push(input);
    return new Response(JSON.stringify({ viewToken: "token", commands: [] }));
  }) as typeof fetch;
  const poller = new HostedViewPoller(250, async () => ({ replies: [{ reply: { viewToken: "token", commands: [{ id: 1, type: "freeze" as const, generation: 1 }] } }] }));
  let failed!: () => void; const rejected = new Promise<void>(resolve => { failed = resolve; });
  const adapter = { call: async () => { throw new Error("Realm gone; local draft uncertain"); } } as unknown as FrameAdapter;
  const client = new HostedViewClient({ pluginId: "official", sessionId: "session", generation: 1, mountId: "tool" }, adapter, { kind: "tool", sessionId: "session", locale: "en", theme: "light" }, assert.fail, failed, poller);
  await client.start(); client.connecting(); client.listen(); await rejected;
  await assert.rejects(client.close(), /local draft uncertain/);
  assert.deepEqual(writes.map(x => x.operation), ["register", "ack"]);
  assert.equal(writes[1].ok, false);
});
