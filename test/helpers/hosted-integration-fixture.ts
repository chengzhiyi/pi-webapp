import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { OFFICIAL_PLUGINS } from "../../src/host/server/plugins/hosted/official-catalog.ts";
export const hostedId = OFFICIAL_PLUGINS[0]!.id;
export const integrity = (bytes: Buffer) => "sha512-" + createHash("sha512").update(bytes).digest("base64");
export function integrationFixture(version = "0.1.0", badReadonly = false, hostRange = ">=0.1.0 <1.0.0") {
  const manifest = { apiVersion: 2, hostRange, runtimeProtocol: 1, backend: { entry: "./dist/runtime.js" }, frontend: { document: "./dist/frame.html", controller: "./dist/frame.html" }, resourcesManifest: "./dist/resources.json", dataSchemaVersion: 1, supportedDataSchemas: [1], capabilities: [...OFFICIAL_PLUGINS[0]!.requiredCapabilities] };
  const mapping = { excalidraw_read_me: "reference", excalidraw_create_view: "view", diagram_reference: "reference", diagram_create: "create", diagram_read: "read", diagram_patch: "patch" };
  const descriptors = Object.entries(mapping).map(([name, action]) => ({ name, action, label: name, description: `${version}: ${name}`, readonly: badReadonly || ["reference", "read"].includes(action), parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } }));
  const files = [
    { path: "dist/runtime.js", mime: "text/javascript", content: `export const createRuntime=()=>({describe:()=>({tools:${JSON.stringify(descriptors)}}),health:()=>({ok:true,schema:1}),invoke:request=>({version:${JSON.stringify(version)},...request}),dispose:()=>{}});` },
    { path: "dist/frame.html", mime: "text/html", content: "<!doctype html><html>isolated fixture</html>" },
  ];
  const entries = [
    { path: "package/package.json", content: JSON.stringify({ name: hostedId, version, type: "module", piWebapp: manifest }) },
    { path: "package/dist/resources.json", content: JSON.stringify({ version: 1, files: files.map(f => ({ path: f.path, mime: f.mime, bytes: Buffer.byteLength(f.content), sha256: createHash("sha256").update(f.content).digest("hex") })) }) },
    ...files.map(f => ({ path: "package/" + f.path, content: f.content })),
  ];
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.content), h = Buffer.alloc(512);
    h.write(entry.path, 0, 100); h.write("0000600\0", 100); h.write("0000000\0", 108); h.write("0000000\0", 116);
    h.write(data.length.toString(8).padStart(11, "0") + "\0", 124); h.write("00000000000\0", 136); h.fill(32, 148, 156);
    h.write("0", 156); h.write("ustar\0", 257); h.write("00", 263);
    h.write([...h].reduce((a, b) => a + b, 0).toString(8).padStart(6, "0") + "\0 ", 148);
    parts.push(h, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  const bytes = gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
  return { bytes, release: { name: hostedId, version, piWebapp: manifest, dist: { tarball: `https://registry.npmjs.org/fixture-${version}.tgz`, integrity: integrity(bytes) } } };
}
