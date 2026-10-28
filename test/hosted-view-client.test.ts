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

test("explicit retry replays a lost freeze ACK and restores the retained realm without repeating freeze", async t => {
  const originalFetch = globalThis.fetch, originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("http://localhost/") });
  t.after(() => { globalThis.fetch = originalFetch; if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation); else Reflect.deleteProperty(globalThis, "location"); });
  let offline = true, failed!: () => void, resumed!: () => void;
  const failure = new Promise<void>(resolve => { failed = resolve; });
  const restored = new Promise<void>(resolve => { resumed = resolve; });
  const writes: any[] = [], calls: string[] = [];
  globalThis.fetch = (async (_url, init) => {
    const input = JSON.parse(init!.body as string); writes.push(input);
    if (input.operation === "ack" && offline) return new Response(JSON.stringify({error:"offline"}), {status:503});
    if (input.operation === "ack" && input.commandId === 2) resumed();
    return new Response(JSON.stringify({viewToken:"retry-token",commands:[]}));
  }) as typeof fetch;
  const poller = new HostedViewPoller(5, async views => ({replies: views.map(view => ({reply:{viewToken:"retry-token",commands: [{id:1,type:"freeze" as const,generation:1},{id:2,type:"resume" as const,generation:1}].filter(command => command.id > view.after)}}))}));
  const adapter = {call: async (method: string) => {calls.push(method);return {checkpoint:"retained"};}} as unknown as FrameAdapter;
  const client = new HostedViewClient({pluginId:"official",sessionId:"retry-session",generation:1,mountId:"retry-editor"},adapter,{kind:"editor",sessionId:"retry-session",locale:"en",theme:"light"},assert.fail,failed,poller);
  await client.start();client.connecting();client.listen();await failure;
  assert.deepEqual(calls,["freeze"]);
  assert.deepEqual(writes.map(input=>input.operation),["register","ack"]);
  offline=false;client.retry();await restored;
  assert.deepEqual(calls,["freeze","restore"]);
  assert.deepEqual(writes.filter(input=>input.operation==="ack").map(input=>[input.commandId,input.ok]),[[1,true],[1,true],[2,true]]);
  await client.close();assert.throws(()=>client.retry(),/Closed view/);
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

test("controller close retires its control capability without requiring an editor frame flush", async t => {
  const originalFetch = globalThis.fetch, originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("http://localhost/") });
  t.after(() => { globalThis.fetch = originalFetch; if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation); else Reflect.deleteProperty(globalThis, "location"); });
  const writes: string[] = [];
  globalThis.fetch = (async (_url, init) => {
    const input = JSON.parse(init!.body as string); writes.push(input.operation);
    return Response.json({ viewToken: "controller-token", commands: [] });
  }) as typeof fetch;
  const adapter = { call: async () => { throw new Error("Old controller document gone"); } } as unknown as FrameAdapter;
  const client = new HostedViewClient({ pluginId: "official", sessionId: "session", generation: 1, mountId: "controller" }, adapter, { kind: "controller", sessionId: "session", locale: "en", theme: "light" }, assert.fail, cause => assert.fail(String(cause)));
  await client.start(); client.connecting();
  await client.close();
  assert.deepEqual(writes, ["register", "close"]);
});

test("a frame never started cancels initialization rather than publishing a fabricated clean status", async t => {
  const originalFetch = globalThis.fetch, originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("http://localhost/") });
  t.after(() => { globalThis.fetch = originalFetch; if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation); else Reflect.deleteProperty(globalThis, "location"); });
  const writes: string[] = [];
  globalThis.fetch = (async (_url, init) => {
    const input = JSON.parse(init!.body as string); writes.push(input.operation);
    return Response.json({ viewToken: "not-initialized", commands: [] });
  }) as typeof fetch;
  const client = new HostedViewClient({ pluginId: "official", sessionId: "session", generation: 1, mountId: "editor" }, {} as FrameAdapter, { kind: "editor", sessionId: "session", locale: "en", theme: "light" }, assert.fail, cause => assert.fail(String(cause)));
  await client.start(); await client.close();
  assert.deepEqual(writes, ["register", "cancel-initialization"]);
});

test("controller committed generation closes and reconnects without an authoring freeze or stale generation change", async t => {
  const originalFetch = globalThis.fetch, originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("http://localhost/") });
  t.after(() => { globalThis.fetch = originalFetch; if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation); else Reflect.deleteProperty(globalThis, "location"); });
  const operations: string[] = [], frameCalls: string[] = [], errors: unknown[] = [];
  let reconnected = false, settled!: () => void;
  const done = new Promise<void>(resolve => { settled = resolve; });
  globalThis.fetch = (async (_url, init) => {
    const input = JSON.parse(init!.body as string); operations.push(input.operation);
    if (input.operation === "change") throw new Error("Committed old-generation controller may not CHANGE");
    return Response.json({ viewToken: "controller-committed-token", commands: [], ...(input.operation === "pollMany" ? {
      replies: [{ reply: { viewToken: "controller-committed-token", commands: [{ id: 1, type: "committed", generation: 9 }] } }],
    } : {}) });
  }) as typeof fetch;
  const adapter = { call: async (method: string) => { frameCalls.push(method); throw new Error("Headless controller has no authoring flush"); } } as unknown as FrameAdapter;
  const client = new HostedViewClient({ pluginId: "official", sessionId: "session", generation: 8, mountId: "controller-committed" }, adapter,
    { kind: "controller", sessionId: "session", locale: "en", theme: "light" },
    () => { reconnected = true; settled(); }, error => { errors.push(error); settled(); });
  await client.start(); client.connecting(); client.listen(); await done;
  await Promise.all([client.close(), client.close()]);
  assert.equal(reconnected, true);
  assert.deepEqual(errors, []); assert.deepEqual(frameCalls, []);
  assert.deepEqual(operations, ["register", "pollMany", "ack", "close"]);
});
