import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import type { HostedPluginCatalog } from "../src/contracts/hosted-plugins.ts";
import { HostedPluginIntegration } from "../src/host/server/plugins/hosted/integration.ts";
import type { OfficialPlugin } from "../src/host/server/plugins/hosted/official-catalog.ts";
import { DEFAULT_POLICIES, EXCALIDRAW_ID, policyFor, type HostedPluginPolicy } from "../src/host/server/plugins/hosted/plugin-policies.ts";

const ID = "@example/tasks";
const plugin: OfficialPlugin = { id: ID, name: "Tasks", description: { zh: "任务", en: "Tasks" }, registry: "https://registry.npmjs.org", recommendedVersion: "0.1.0", requiredCapabilities: ["state"] };
const policy: HostedPluginPolicy = { tools: { task_list: "list" }, readonlyActions: ["list"], actions: ["list", "sync"], checkpointActions: ["sync"],
  contribution: { entry: { label: "Tasks", description: { zh: "任务", en: "Task board" }, kind: "workspace" }, panels: ["workspace"], artifactTools: [], toolViews: [], panelAlias: { prefix: "task:", kind: "workspace", title: "Tasks" } } };

function fixture(tool: { name: string; action: string; readonly: boolean }) {
  const manifest = { apiVersion: 2, hostRange: ">=0.1.0 <1.0.0", runtimeProtocol: 1, backend: { entry: "./dist/runtime.js" }, frontend: { document: "./dist/frame.html", controller: "./dist/frame.html" }, resourcesManifest: "./dist/resources.json", dataSchemaVersion: 1, supportedDataSchemas: [1], capabilities: ["state"] };
  const descriptor = { ...tool, label: tool.name, description: "t", parameters: { type: "object", properties: {} } };
  const files = [
    { path: "dist/runtime.js", mime: "text/javascript", content: `export const createRuntime=()=>({describe:()=>({tools:[${JSON.stringify(descriptor)}]}),health:()=>({ok:true}),invoke:r=>r,dispose(){}})` },
    { path: "dist/frame.html", mime: "text/html", content: "<!doctype html><html></html>" },
  ];
  const entries = [
    { path: "package/package.json", content: JSON.stringify({ name: ID, version: "0.1.0", type: "module", piWebapp: manifest }) },
    { path: "package/dist/resources.json", content: JSON.stringify({ version: 1, files: files.map(f => ({ path: f.path, mime: f.mime, bytes: Buffer.byteLength(f.content), sha256: createHash("sha256").update(f.content).digest("hex") })) }) },
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
  return { bytes, release: { name: ID, version: "0.1.0", piWebapp: manifest, dist: { tarball: "https://registry.npmjs.org/t.tgz", integrity: "sha512-" + createHash("sha512").update(bytes).digest("base64") } } };
}
async function run(t: { after(fn: () => Promise<void>): void }, tool: { name: string; action: string; readonly: boolean }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-policy-"))), workerEntry = join(root, "worker.mjs"), f = fixture(tool);
  await build({ entryPoints: [new URL("../src/host/server/plugins/hosted/worker-entry.ts", import.meta.url).pathname], outfile: workerEntry, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  const integration = new HostedPluginIntegration({ root: join(root, "hosted"), hostVersion: "0.1.29", workerEntry, ownerId: "o", catalog: [plugin], policies: new Map([[ID, policy]]),
    resolveSession: () => null,
    fetch: (async (url: string | URL | Request) => String(url).endsWith(".tgz") ? new Response(new Uint8Array(f.bytes)) : new Response(JSON.stringify({ versions: { "0.1.0": f.release } }))) as typeof fetch });
  t.after(async () => { integration.adapter.thaw(); await integration.shutdown(); await rm(root, { recursive: true, force: true }); });
  await integration.start();
  return integration;
}
test("policy registry: built-in policies are reviewed ids only; unknown ids are unreviewed", () => {
  assert.deepEqual([...DEFAULT_POLICIES.keys()], [EXCALIDRAW_ID, "@chengzhiyi/pi-github", "@chengzhiyi/pi-pencil"]);
  assert.throws(() => policyFor(DEFAULT_POLICIES, ID), { code: "unreviewed_plugin" });
});
test("a non-excalidraw catalog plugin installs, enables and publishes its own reviewed contribution", async t => {
  const integration = await run(t, { name: "task_list", action: "list", readonly: true });
  await integration.handlers.manage({ pluginId: ID, operation: "install" } as never);
  const catalog = await integration.handlers.manage({ pluginId: ID, operation: "enable" } as never) as HostedPluginCatalog;
  const card = catalog.plugins.find(p => p.pluginId === ID)!;
  assert.equal(card.contribution?.entry.label, "Tasks");
  assert.ok(card.documentUrl);
  await assert.rejects(integration.handlers.action({ pluginId: ID, generation: card.generation!, sessionId: "s", action: "raw-broker", input: {} } as never), { code: "invalid_scope" });
});
test("tools outside the reviewed policy are rejected at enable", async t => {
  for (const tool of [{ name: "task_delete", action: "list", readonly: true }, { name: "task_list", action: "sync", readonly: false }, { name: "task_list", action: "list", readonly: false }]) {
    const integration = await run(t, tool);
    await integration.handlers.manage({ pluginId: ID, operation: "install" } as never);
    await assert.rejects(integration.handlers.manage({ pluginId: ID, operation: "enable" } as never), { code: "unreviewed_tool" });
  }
});
