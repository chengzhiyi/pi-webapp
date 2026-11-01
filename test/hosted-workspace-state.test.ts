import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { HostedPluginManager } from "../src/host/server/plugins/hosted/manager.ts";
import { OFFICIAL_PLUGINS } from "../src/host/server/plugins/hosted/official-catalog.ts";
import { sha256 } from "../src/host/server/plugins/hosted/resources.ts";

const id = OFFICIAL_PLUGINS[0]!.id;
const RUNTIME = `export const createRuntime = ctx => ({describe:()=>({tools:[]}),health:()=>({ok:true}),dispose(){},
  async invoke(req){
    const { key, scope, value } = req.input;
    const cur = await ctx.broker.call("state.read",{key,scope});
    if (req.action === "get") return cur?.value ?? null;
    return ctx.broker.call("state.compareAndSwap",{key,scope,expectedRevision:cur?.revision??0,schema:1,value});
  }})`;
function fixture() {
  const manifest = { apiVersion: 2, hostRange: ">=0.1.0 <1.0.0", runtimeProtocol: 1, backend: { entry: "./dist/runtime.js" }, frontend: { document: "./dist/frame.html", controller: "./dist/frame.html" }, resourcesManifest: "./dist/resources.json", dataSchemaVersion: 1, supportedDataSchemas: [1], capabilities: [...OFFICIAL_PLUGINS[0]!.requiredCapabilities] };
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
  return { bytes, release: { name: id, version: "0.1.0", piWebapp: manifest, dist: { tarball: "https://registry.npmjs.org/f.tgz", integrity: "sha512-" + createHash("sha512").update(bytes).digest("base64") } } };
}
test("workspace-scoped state is shared across sessions and ticks of one workspace, isolated from others and from session state", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-wsstate-")), workerEntry = join(root, "worker.mjs");
  await build({ entryPoints: [new URL("../src/host/server/plugins/hosted/worker-entry.ts", import.meta.url).pathname], outfile: workerEntry, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  const f = fixture();
  const manager = new HostedPluginManager({ root, workerEntry, hostVersion: "0.1.29",
    fetch: (async (url: string | URL | Request) => String(url).endsWith(".tgz") ? new Response(new Uint8Array(f.bytes)) : new Response(JSON.stringify({ versions: { "0.1.0": f.release } }))) as typeof fetch,
    hooks: () => ({ canSwitch: () => true, freeze: async () => {}, resume: async () => {}, committed: async () => {} }) });
  t.after(async () => { try { await manager.shutdown(); } finally { await rm(root, { recursive: true, force: true }); } });
  await manager.manage(id, "install"); await manager.manage(id, "enable");
  const generation = (await manager.inventory()).plugins.find(p => p.id === id)!.generation!;
  const run = (cwd: string, sessionId: string, action: "get" | "put", input: Record<string, unknown>) =>
    manager.invoke(id, generation, { requestId: crypto.randomUUID(), scope: { cwd, workspaceId: "w:" + cwd, sessionId }, kind: "action", action, input });
  await run("/a", "chat-1", "put", { key: "tasks", scope: "workspace", value: ["t1"] });
  assert.deepEqual(await run("/a", "chat-2", "get", { key: "tasks", scope: "workspace" }), ["t1"], "another session sees it");
  assert.deepEqual(await run("/a", "scheduler", "get", { key: "tasks", scope: "workspace" }), ["t1"], "scheduler tick sees it");
  assert.equal(await run("/b", "chat-1", "get", { key: "tasks", scope: "workspace" }), null, "other workspace isolated");
  assert.equal(await run("/a", "chat-1", "get", { key: "tasks" }), null, "default scope stays per session");
  await run("/a", "chat-1", "put", { key: "tasks", value: "mine" });
  assert.equal(await run("/a", "chat-2", "get", { key: "tasks" }), null);
  assert.deepEqual(await run("/a", "chat-2", "get", { key: "tasks", scope: "workspace" }), ["t1"], "session write did not touch workspace state");
  await run("/a", "chat-2", "put", { key: "tasks", scope: "workspace", value: ["t1", "t2"] });
  assert.deepEqual(await run("/a", "chat-1", "get", { key: "tasks", scope: "workspace" }), ["t1", "t2"]);
  await assert.rejects(run("/a", "chat-1", "get", { key: "tasks", scope: "global" }), { code: "invalid_input" });
});
