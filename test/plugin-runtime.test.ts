import assert from "node:assert/strict";
import test from "node:test";
import { WebPluginRuntime } from "../web/src/plugin-manager.ts";

const catalog = { plugins: [{ id: "example", client: "/example.js", style: "/example.css" }], errors: [] };
const definition = (activate: (context: any) => void = () => {}) => ({ id: "example", apiVersion: 1, activate });

test("activation resources abort first, dispose in reverse order, and survive a throwing cleanup", async () => {
  const calls: string[] = [];
  const runtime = new WebPluginRuntime({
    loadModule: async () => ({ default: definition(ctx => {
      ctx.signal.addEventListener("abort", () => calls.push("abort"));
      ctx.onDispose(() => calls.push("first"));
      ctx.onDispose(() => { calls.push("second"); throw new Error("cleanup failed"); });
    }) }),
    loadStyle: async () => () => { calls.push("style"); }, report: () => {},
  });
  await runtime.start("s1", async () => catalog);
  assert.equal(runtime.getSnapshot().plugins.length, 1);
  runtime.dispose(); runtime.dispose();
  assert.deepEqual(calls, ["abort", "second", "first", "style"]);
});

test("a late module from the previous session cannot activate or publish", async () => {
  let finish!: (value: unknown) => void;
  const activated: string[] = [];
  let first = true;
  const runtime = new WebPluginRuntime({
    loadModule: () => first ? (first = false, new Promise(resolve => { finish = resolve; })) : Promise.resolve({ default: definition(ctx => { activated.push(ctx.sessionId); }) }),
    loadStyle: async () => () => {}, report: () => {},
  });
  const old = runtime.start("old", async () => catalog);
  await new Promise(resolve => setImmediate(resolve));
  await runtime.start("new", async () => catalog);
  finish({ default: definition(ctx => { activated.push(ctx.sessionId); }) });
  await old;
  assert.deepEqual(activated, ["new"]);
  assert.equal(runtime.getSnapshot().sessionId, "new");
  runtime.dispose();
});

test("activation failure releases resources and does not prevent the next plugin", async () => {
  const calls: string[] = [];
  const runtime = new WebPluginRuntime({
    loadModule: async url => ({ default: url === "/bad.js" ? { id: "bad", apiVersion: 1, activate(ctx: any) { ctx.onDispose(() => calls.push("cleanup")); throw new Error("broken activation"); } } : definition() }),
    loadStyle: async () => () => { calls.push("style"); }, report: () => {},
  });
  await runtime.start("s1", async () => ({ plugins: [{ id: "bad", client: "/bad.js", style: "/bad.css" }, catalog.plugins[0]!], errors: [] }));
  assert.deepEqual(runtime.getSnapshot().plugins.map(p => p.id), ["example"]);
  assert.match(runtime.getSnapshot().errors.join(" "), /bad.*activate.*broken activation/);
  assert.deepEqual(calls, ["cleanup", "style"]);
  runtime.dispose();
});

test("missing module contract and load timeout are diagnosed without activating late results", async () => {
  let activated = 0;
  const runtime = new WebPluginRuntime({
    loadModule: async url => url === "/missing.js" ? {} : new Promise(resolve => setTimeout(() => resolve({ default: definition(() => activated++) }), 30)),
    loadStyle: async () => () => {}, report: () => {}, loadTimeoutMs: 5,
  });
  await runtime.start("s1", async () => ({ plugins: [{ id: "missing", client: "/missing.js" }, { id: "example", client: "/slow.js" }], errors: [] }));
  assert.match(runtime.getSnapshot().errors.join(" "), /default/);
  assert.match(runtime.getSnapshot().errors.join(" "), /timed out/);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(activated, 0);
  runtime.dispose();
});

test("disconnect and Strict Mode remount dispose each activation once", async () => {
  let active = 0;
  const runtime = new WebPluginRuntime({
    loadModule: async () => ({ default: definition(ctx => { active++; ctx.onDispose(() => active--); }) }),
    loadStyle: async () => () => {}, report: () => {},
  });
  await runtime.start("same", async () => catalog);
  assert.equal(active, 1);
  runtime.dispose();
  assert.equal(active, 0);
  await runtime.start("same", async () => catalog);
  assert.equal(active, 1);
  runtime.dispose();
  assert.equal(active, 0);
});

test("missing activate and asynchronous activation fail the contract and release their scopes", async () => {
  let disposed = 0;
  const runtime = new WebPluginRuntime({
    loadModule: async url => ({ default: url === "/missing.js" ? { id: "missing", apiVersion: 1 } : { id: "async", apiVersion: 1, async activate(ctx: any) { ctx.onDispose(() => { disposed++; }); } } }),
    loadStyle: async () => () => {}, report: () => {},
  });
  await runtime.start("s", async () => ({ plugins: [{ id: "missing", client: "/missing.js" }, { id: "async", client: "/async.js" }], errors: [] }));
  assert.deepEqual(runtime.getSnapshot().plugins, []);
  assert.match(runtime.getSnapshot().errors.join(" "), /synchronous activate/);
  assert.match(runtime.getSnapshot().errors.join(" "), /return void/);
  assert.equal(disposed, 1);
  runtime.dispose();
});

test("late stylesheet completion is cleaned after disconnect and old catalog results are ignored", async () => {
  let finishStyle!: (cleanup: () => void) => void;
  let finishCatalog!: (value: typeof catalog) => void;
  let removed = 0; let activated = 0;
  const runtime = new WebPluginRuntime({
    loadModule: async () => ({ default: definition(() => { activated++; }) }),
    loadStyle: () => new Promise(resolve => { finishStyle = resolve; }), report: () => {},
  });
  const first = runtime.start("s1", async () => catalog);
  await new Promise(resolve => setImmediate(resolve));
  runtime.dispose();
  finishStyle(() => { removed++; }); await first;
  assert.equal(removed, 1); assert.equal(activated, 0);
  const second = runtime.start("s2", () => new Promise(resolve => { finishCatalog = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  runtime.dispose(); finishCatalog(catalog); await second;
  assert.equal(activated, 0); assert.equal(runtime.getSnapshot().sessionId, null);
});
