import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { HostedPluginIntegration } from "../src/host/server/plugins/hosted/integration.ts";
import type { OfficialPlugin } from "../src/host/server/plugins/hosted/official-catalog.ts";
import type { HostedPluginPolicy } from "../src/host/server/plugins/hosted/plugin-policies.ts";

const A = "@example/first", B = "@example/second";
const entry = (id: string): OfficialPlugin => ({ id, name: id, description: { zh: id, en: id }, registry: "https://registry.npmjs.org", recommendedVersion: "0.1.0", requiredCapabilities: ["state"] });
const policy: HostedPluginPolicy = { tools: {}, readonlyActions: [], actions: ["get"], checkpointActions: [], contribution: { entry: { label: "x", description: { zh: "x", en: "x" }, kind: "workspace" }, panels: ["workspace"], artifactTools: [], toolViews: [], panelAlias: { prefix: "x:", kind: "workspace", title: "x" } } };
function archive(id: string) {
  const manifest = { apiVersion: 2, hostRange: ">=0.1.0 <1.0.0", runtimeProtocol: 1, backend: { entry: "./dist/runtime.js" }, frontend: { document: "./dist/frame.html", controller: "./dist/frame.html" }, resourcesManifest: "./dist/resources.json", dataSchemaVersion: 1, supportedDataSchemas: [1], capabilities: ["state"] };
  const files = [{ path: "dist/runtime.js", mime: "text/javascript", content: "export const createRuntime=()=>({describe:()=>({tools:[]}),health:()=>({ok:true}),invoke:r=>r,dispose(){}})" }, { path: "dist/frame.html", mime: "text/html", content: "<!doctype html><html></html>" }];
  const entries = [{ path: "package/package.json", content: JSON.stringify({ name: id, version: "0.1.0", type: "module", piWebapp: manifest }) },
    { path: "package/dist/resources.json", content: JSON.stringify({ version: 1, files: files.map(f => ({ path: f.path, mime: f.mime, bytes: Buffer.byteLength(f.content), sha256: createHash("sha256").update(f.content).digest("hex") })) }) },
    ...files.map(f => ({ path: "package/" + f.path, content: f.content }))];
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
  return { bytes, release: { name: id, version: "0.1.0", piWebapp: manifest, dist: { tarball: "https://registry.npmjs.org/p.tgz", integrity: "sha512-" + createHash("sha512").update(bytes).digest("base64") } } };
}
test("host shutdown still lets a LATER plugin's open workspace view freeze (consent is not revoked per plugin)", { timeout: 30_000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-multi-"))), workerEntry = join(root, "worker.mjs"), pack = archive(B);
  await build({ entryPoints: [new URL("../src/host/server/plugins/hosted/worker-entry.ts", import.meta.url).pathname], outfile: workerEntry, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  const integration = new HostedPluginIntegration({ root: join(root, "hosted"), hostVersion: "0.1.29", workerEntry, ownerId: "o", catalog: [entry(A), entry(B)], policies: new Map([[A, policy], [B, policy]]),
    resolveSession: id => id === "chat" ? { cwd: root, workspaceId: "w", sessionId: "chat" } : null,
    fetch: (async (url: string | URL | Request) => String(url).endsWith(".tgz") ? new Response(new Uint8Array(pack.bytes)) : new Response(JSON.stringify({ versions: { "0.1.0": pack.release } }))) as typeof fetch });
  t.after(async () => { integration.adapter.thaw(); await rm(root, { recursive: true, force: true }); });
  await integration.start();
  await integration.handlers.manage({ pluginId: B, operation: "install" } as never);
  await integration.handlers.manage({ pluginId: B, operation: "enable" } as never);
  const generation = (await integration.inventory()).plugins.find(p => p.pluginId === B)!.generation!;
  const identity = { pluginId: B, sessionId: "chat", generation, mountId: "m1" }, viewToken = crypto.randomUUID();
  await integration.handlers.views({ ...identity, operation: "register", kind: "workspace", viewToken });
  await integration.handlers.views({ ...identity, viewToken, operation: "change", dirty: false, busy: false });
  const stopping = integration.shutdown();
  let acked = false;
  for (let i = 0; i < 50 && !acked; i++) {
    const poll = await integration.handlers.views({ ...identity, viewToken, operation: "poll", after: 0, immediate: true }) as { commands: Array<{ id: number; type: string }> };
    const freeze = poll.commands.find(c => c.type === "freeze");
    if (freeze) { await integration.handlers.views({ ...identity, viewToken, operation: "ack", commandId: freeze.id, ok: true }); acked = true; } else await new Promise(r => setTimeout(r, 50));
  }
  assert.ok(acked, "the open workspace view was asked to freeze");
  await stopping;
});
