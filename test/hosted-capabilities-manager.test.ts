import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { HostedPluginManager } from "../src/host/server/plugins/hosted/manager.ts";
import { MemorySecretStore } from "../src/host/server/plugins/hosted/capabilities/secrets.ts";
import { OFFICIAL_PLUGINS } from "../src/host/server/plugins/hosted/official-catalog.ts";
import { sha256 } from "../src/host/server/plugins/hosted/resources.ts";

const id = OFFICIAL_PLUGINS[0]!.id;
// Runtime counts scheduled ticks and can perform a brokered fetch; results land in plugin state.
const RUNTIME = `export const createRuntime = ctx => ({describe:()=>({tools:[]}),health:()=>({ok:true}),dispose(){},
  async invoke(req){
    const read = async k => (await ctx.broker.call("state.read",{key:k}));
    const write = async (k,v) => { const cur = await read(k); return ctx.broker.call("state.compareAndSwap",{key:k,expectedRevision:cur?.revision??0,schema:1,value:v}); };
    if (req.action === "sync") return write("tick", req.input.schedule);
    if (req.action === "net") { try { return await write("net", await ctx.broker.call("network.fetch",{url:req.input.url,secret:"github-token"})); } catch (e) { return write("net", {error:e.code}); } }
    return (await read(req.input.key))?.value ?? null;
  }})`;
function fixture() {
  const manifest = { apiVersion: 2, hostRange: ">=0.1.0 <1.0.0", runtimeProtocol: 1, backend: { entry: "./dist/runtime.js" }, frontend: { document: "./dist/frame.html", controller: "./dist/frame.html" }, resourcesManifest: "./dist/resources.json", dataSchemaVersion: 1, supportedDataSchemas: [1],
    capabilities: [...OFFICIAL_PLUGINS[0]!.requiredCapabilities, "scheduler", "network", "secrets"], secrets: [{ name: "github-token" }], network: { hosts: ["api.github.com"] }, schedules: [{ id: "poll", intervalSec: 60, action: "sync" }] };
  const files = [{ path: "dist/runtime.js", content: RUNTIME, mime: "text/javascript" }, { path: "dist/frame.html", content: "<!doctype html><html></html>", mime: "text/html" }];
  const entries = [
    { path: "package/package.json", content: JSON.stringify({ name: id, version: "0.1.0", type: "module", piWebapp: manifest }) },
    { path: "package/dist/resources.json", content: JSON.stringify({ version: 1, files: files.map(f => ({ path: f.path, bytes: Buffer.byteLength(f.content), sha256: sha256(f.content), mime: f.mime })) }) },
    ...files.map(f => ({ path: "package/" + f.path, content: f.content })),
  ];
  const parts: Buffer[] = [];
  for (const e of entries) {
    const data = Buffer.from(e.content), h = Buffer.alloc(512);
    h.write(e.path, 0, 100); h.write("0000600\0", 100); h.write("0000000\0", 108); h.write("0000000\0", 116);
    h.write(data.length.toString(8).padStart(11, "0") + "\0", 124); h.write("00000000000\0", 136); h.fill(32, 148, 156);
    h.write("0", 156); h.write("ustar\0", 257); h.write("00", 263);
    h.write([...h].reduce((a, b) => a + b, 0).toString(8).padStart(6, "0") + "\0 ", 148);
    parts.push(h, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  const bytes = gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
  const integrity = "sha512-" + createHash("sha512").update(bytes).digest("base64");
  return { bytes, release: { name: id, version: "0.1.0", piWebapp: manifest, dist: { tarball: "https://registry.npmjs.org/fixture.tgz", integrity } } };
}
test("manager starts declared schedules on enable, runs ticks in the plugin, brokers fetch, and stops on disable", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-hosted-cap-")), workerEntry = join(root, "worker.mjs");
  await build({ entryPoints: [new URL("../src/host/server/plugins/hosted/worker-entry.ts", import.meta.url).pathname], outfile: workerEntry, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  const f = fixture(), timers = new Map<number, () => void>(); let next = 0, scope: { cwd: string; workspaceId: string; sessionId: string } | null = null, auth = "";
  const secrets = new MemorySecretStore(); await secrets.set(id, "github-token", "ghp_T");
  const manager = new HostedPluginManager({ root, workerEntry, hostVersion: "0.1.29",
    fetch: (async (url: string | URL | Request) => String(url).endsWith(".tgz") ? new Response(new Uint8Array(f.bytes)) : new Response(JSON.stringify({ versions: { "0.1.0": f.release } }))) as typeof fetch,
    hooks: () => ({ canSwitch: () => true, freeze: async () => {}, resume: async () => {}, committed: async () => {} }),
    capabilities: { secrets, resolve: async () => ["140.82.112.5"], fetch: (async (_u: URL, init: RequestInit) => { auth = (init.headers as Record<string, string>).Authorization!; return new Response("ok"); }) as unknown as typeof fetch },
    scheduledScope: () => scope, scheduleTimers: { setInterval: (fn, ms) => { assert.equal(ms, 60_000); timers.set(++next, fn); return next; }, clearInterval: h => { timers.delete(h as number); } } });
  t.after(async () => { try { await manager.shutdown(); } finally { await rm(root, { recursive: true, force: true }); } });
  await manager.manage(id, "install"); await manager.manage(id, "enable");
  assert.equal(timers.size, 1);
  const generation = (await manager.inventory()).plugins.find(p => p.id === id)!.generation!;
  const run = (action: string, input: unknown) => manager.invoke(id, generation, { requestId: crypto.randomUUID(), scope: { cwd: root, workspaceId: "w", sessionId: "s" }, kind: "action", action, input });
  const settle = () => new Promise(r => setTimeout(r, 300));
  [...timers.values()][0]!(); await settle();
  assert.equal(await run("read", { key: "tick" }), null, "no authenticated scope -> tick skipped");
  scope = { cwd: root, workspaceId: "w", sessionId: "s" };
  [...timers.values()][0]!(); await settle();
  assert.equal(await run("read", { key: "tick" }), "poll");
  await run("net", { url: "https://api.github.com/user" });
  assert.equal(auth, "Bearer ghp_T");
  assert.equal(((await run("read", { key: "net" })) as { body: string }).body, "ok");
  await run("net", { url: "https://evil.example/" });
  assert.deepEqual(await run("read", { key: "net" }), { error: "network_denied" });
  await manager.manage(id, "disable");
  assert.equal(timers.size, 0);
});
