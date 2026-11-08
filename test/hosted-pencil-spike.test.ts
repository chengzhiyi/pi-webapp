// pi-pencil spike: per-plugin CSP (H1), WASM/TTF resources (H2), rule-based binary workspace files (H3).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { HostedStateBroker } from "../src/host/server/plugins/hosted/state-broker.ts";
import { HOSTED_FRAME_CSP, hostedFrameCsp, manifestRequestsWasm } from "../src/host/server/plugins/hosted/frame-csp.ts";
import { DEFAULT_POLICIES, DEFAULT_WORKSPACE_FILES, PENCIL_ID, EXCALIDRAW_ID, workspaceRulesFor, invokeTimeoutFor } from "../src/host/server/plugins/hosted/plugin-policies.ts";
import { validateHostedPackage } from "../src/host/server/plugins/hosted/resources.ts";

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

test("H1: default hosted CSP is byte-identical to the historical policy; wasm adds only 'wasm-unsafe-eval'", () => {
  assert.equal(HOSTED_FRAME_CSP, "default-src 'none'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; font-src 'self' data:; connect-src 'self'; img-src 'self' data: blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'");
  assert.equal(hostedFrameCsp(), HOSTED_FRAME_CSP);
  const wasm = hostedFrameCsp({ wasm: true });
  assert.match(wasm, /script-src 'self' 'wasm-unsafe-eval';/);
  assert.doesNotMatch(wasm, /'unsafe-eval'|'unsafe-inline' ;|script-src[^;]*unsafe-inline/);
  assert.equal(wasm.replace(" 'wasm-unsafe-eval'", ""), HOSTED_FRAME_CSP);
});

test("H1: a package must declare both browser.wasm and the capability; policy is checked separately", () => {
  assert.equal(manifestRequestsWasm({ browser: { wasm: true }, capabilities: ["state", "browser.wasm"] }), true);
  assert.equal(manifestRequestsWasm({ browser: { wasm: true }, capabilities: ["state"] }), false);
  assert.equal(manifestRequestsWasm({ capabilities: ["browser.wasm"] }), false);
  assert.equal(DEFAULT_POLICIES.get(EXCALIDRAW_ID)?.browser?.wasm, undefined, "excalidraw is not granted wasm");
  assert.equal(DEFAULT_POLICIES.get(PENCIL_ID)?.browser?.wasm, true);
});

test("H3 policy: excalidraw keeps the historical rule; pencil gets binary .fig and a bounded timeout", () => {
  assert.deepEqual(workspaceRulesFor(DEFAULT_POLICIES, EXCALIDRAW_ID), DEFAULT_WORKSPACE_FILES);
  assert.deepEqual(workspaceRulesFor(DEFAULT_POLICIES, "@chengzhiyi/pi-github"), DEFAULT_WORKSPACE_FILES);
  assert.deepEqual(workspaceRulesFor(DEFAULT_POLICIES, PENCIL_ID).map(r => [r.extension, r.binary]), [[".fig", true]]);
  assert.equal(invokeTimeoutFor(DEFAULT_POLICIES, EXCALIDRAW_ID), undefined);
  assert.equal(invokeTimeoutFor(DEFAULT_POLICIES, PENCIL_ID), 120_000);
});

async function broker(t: test.TestContext, rules = workspaceRulesFor(DEFAULT_POLICIES, PENCIL_ID)) {
  const root = await mkdtemp(join(tmpdir(), "pencil-broker-")); t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "workspace"); await mkdir(cwd);
  const b = new HostedStateBroker(join(root, "state"), PENCIL_ID, undefined, undefined, rules);
  await b.activate(0, { version: "0.0.0", schema: 1, stateRef: randomUUID(), enabled: true });
  const call = (method: string, input: unknown) => b.call({ requestId: randomUUID(), generation: 1, scope: { cwd, sessionId: "s", workspaceId: "w" }, kind: "action", action: "save", input: {} }, method, input);
  return { cwd, call };
}

test("H3 broker: binary .fig round trip with hash CAS, no-replace, conflict and size limits", async t => {
  const { cwd, call } = await broker(t);
  const bytes = Buffer.from([0x66, 0x69, 0x67, 0x2d, 0x6b, 0x69, 0x77, 0x69, 0, 255, 1, 2, 3]); // not valid UTF-8
  const saved = await call("workspace.commit", { path: "designs/a.fig", base64: bytes.toString("base64"), expectedHash: null }) as { hash: string };
  assert.equal(saved.hash, sha(bytes), "parent 'designs' created by the reviewed rule");
  assert.deepEqual(await readFile(join(cwd, "designs/a.fig")), bytes);
  const read = await call("workspace.read", { path: "designs/a.fig", encoding: "base64" }) as { base64: string; hash: string; bytes: number };
  assert.equal(read.hash, saved.hash); assert.deepEqual(Buffer.from(read.base64, "base64"), bytes);
  await assert.rejects(call("workspace.commit", { path: "designs/a.fig", base64: "AA==", expectedHash: null }), { code: "file_conflict" }, "no-replace");
  await writeFile(join(cwd, "designs/a.fig"), "external");
  await assert.rejects(call("workspace.commit", { path: "designs/a.fig", base64: "AA==", expectedHash: saved.hash }), { code: "file_conflict" }, "external change detected");
  await assert.rejects(call("workspace.commit", { path: "designs/b.fig", text: "x", expectedHash: null }), { code: "invalid_input" }, "binary rule refuses text");
  await assert.rejects(call("workspace.read", { path: "designs/a.fig", encoding: "utf-8" }), { code: "invalid_input" });
  await assert.rejects(call("workspace.commit", { path: "notes/a.excalidraw", text: "{}", expectedHash: null }), { code: "invalid_path" }, "pencil cannot write excalidraw files");
  await assert.rejects(call("workspace.commit", { path: "../escape.fig", base64: "AA==", expectedHash: null }), { code: "invalid_path" });
  await assert.rejects(call("workspace.commit", { path: "other/x.fig", base64: "AA==", expectedHash: null }), { code: "invalid_path" }, "only the reviewed directory may be created");
});

test("H3 broker: default rule still behaves exactly like the old .excalidraw path", async t => {
  const { call } = await broker(t, DEFAULT_WORKSPACE_FILES);
  const saved = await call("workspace.commit", { path: "diagrams/a.excalidraw", text: "{}", expectedHash: null }) as { hash: string };
  assert.deepEqual(await call("workspace.read", { path: "diagrams/a.excalidraw", maxBytes: 512 * 1024 }), { text: "{}", hash: saved.hash });
  await assert.rejects(call("workspace.commit", { path: "designs/a.fig", base64: "AA==", expectedHash: null }), { code: "invalid_path" });
  await assert.rejects(call("workspace.read", { path: "diagrams/a.excalidraw", maxBytes: 513 * 1024 }), { code: "invalid_input" });
});

test("H2: packages may ship .wasm (16 MiB class), .ttf/.otf fonts and backend .cjs glue", async t => {
  const root = await mkdtemp(join(tmpdir(), "pencil-pkg-")); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "dist"));
  const files: Record<string, [Buffer, string]> = {
    "dist/runtime.js": [Buffer.from("export const createRuntime=()=>({});"), "text/javascript"],
    "dist/frame.html": [Buffer.from("<!doctype html>"), "text/html"],
    "dist/canvaskit.wasm": [Buffer.alloc(9 * 1024 * 1024, 1), "application/wasm"],
    "dist/glue.cjs": [Buffer.from("module.exports = 1;"), "text/javascript"],
    "dist/NotoSansSC-Regular.ttf": [Buffer.alloc(3 * 1024 * 1024, 2), "font/ttf"],
  };
  for (const [path, [bytes]] of Object.entries(files)) await writeFile(join(root, path), bytes);
  await writeFile(join(root, "dist/resources.json"), JSON.stringify({ version: 1, files: Object.entries(files).map(([path, [bytes, mime]]) => ({ path: `./${path}`, bytes: bytes.length, sha256: sha(bytes), mime })) }));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: PENCIL_ID, version: "0.0.1", type: "module", piWebapp: { apiVersion: 2, hostRange: ">=0.1.0", runtimeProtocol: 1, backend: { entry: "./dist/runtime.js" }, frontend: { document: "./dist/frame.html", controller: "./dist/frame.html" }, resourcesManifest: "./dist/resources.json", dataSchemaVersion: 1, supportedDataSchemas: [1], capabilities: ["state", "browser.wasm"], browser: { wasm: true } } }));
  const pkg = await validateHostedPackage(root, PENCIL_ID);
  assert.equal(pkg.resources.get("dist/canvaskit.wasm")?.mime, "application/wasm");
  assert.ok(manifestRequestsWasm(pkg.manifest));
});
