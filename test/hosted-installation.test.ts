import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveMembers } from "../src/host/server/plugins/hosted/archive.ts";
import { HostedPluginInstaller, verifyArchiveIntegrity } from "../src/host/server/plugins/hosted/installer.ts";
import { OFFICIAL_PLUGINS, selectRelease, hostUpdateDecision } from "../src/host/server/plugins/hosted/official-catalog.ts";
import { compareVersions, satisfiesHost } from "../src/host/server/plugins/hosted/versions.ts";
import { sha256 } from "../src/host/server/plugins/hosted/resources.ts";
import { failure } from "../src/host/server/plugins/hosted/errors.ts";
import { legacyCheckpointLoader } from "../src/host/server/plugins/hosted/legacy-checkpoints.ts";
import { writeLegacyCheckpoint } from "./helpers/legacy-checkpoint.ts";

const id = OFFICIAL_PLUGINS[0]!.id;
const code = (expected: string) => (e: unknown) => (e as {code?: string}).code === expected;
const sri = (bytes: Buffer) => "sha512-" + createHash("sha512").update(bytes).digest("base64");
async function temporary(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "pi-hosted-install-"));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
function tar(entries: Array<{ path: string; content?: string; type?: string; link?: string }>): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.content ?? ""), h = Buffer.alloc(512);
    h.write(entry.path, 0, 100); h.write("0000600\0", 100); h.write("0000000\0", 108); h.write("0000000\0", 116);
    h.write(data.length.toString(8).padStart(11, "0") + "\0", 124); h.write("00000000000\0", 136); h.fill(32, 148, 156);
    h.write(entry.type ?? "0", 156); if (entry.link) h.write(entry.link, 157, 100);
    h.write("ustar\0", 257); h.write("00", 263);
    h.write([...h].reduce((a, b) => a + b, 0).toString(8).padStart(6, "0") + "\0 ", 148);
    parts.push(h, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
}
function fixture(version = "0.1.0", extra: Record<string, unknown> = {}) {
  const manifest = { apiVersion: 2, hostRange: ">=0.1.0 <1.0.0", runtimeProtocol: 1, backend: { entry: "./dist/runtime.js" }, frontend: { document: "./dist/frame.html", controller: "./dist/frame.html" }, resourcesManifest: "./dist/resources.json", dataSchemaVersion: 1, supportedDataSchemas: [1], capabilities: [...OFFICIAL_PLUGINS[0]!.requiredCapabilities] };
  const files = [{ path: "dist/runtime.js", content: "export const createRuntime = () => ({describe:()=>({tools:[]}),health:()=>true,invoke:()=>null})", mime: "text/javascript" }, { path: "dist/frame.html", content: "<!doctype html><html></html>", mime: "text/html" }];
  const entries = [ { path: "package/package.json", content: JSON.stringify({name: id, version, type: "module", piWebapp: manifest, ...extra}) },
    { path: "package/dist/resources.json", content: JSON.stringify({version: 1, files: files.map(f => ({path: f.path, bytes: Buffer.byteLength(f.content), sha256: sha256(f.content), mime: f.mime}))}) },
    ...files.map(f => ({path: "package/" + f.path, content: f.content})) ];
  const bytes = tar(entries);
  return { bytes, entries, manifest, release: { name: id, version, piWebapp: manifest, dist: {tarball: `https://registry.npmjs.org/${id}/-/pi-excalidraw-${version}.tgz`, integrity: sri(bytes)} } };
}

test("bounded stable version selection rejects incompatible latest/prerelease and malformed range", () => {
  assert.equal(compareVersions("1.2.0", "1.1.99") > 0, true);
  for (const range of [">=0.1.0 <1.0.0", "^0.1.20", "~0.1.0", "0.1.29 || 1.0.0"]) assert.equal(satisfiesHost("0.1.29", range), true);
  for (const range of ["^0.0.9", ">=1.0.0", "*", ">=0.1.0 || *", ">=0.1.0 garbage", ">=0.1.0 ||"]) assert.equal(satisfiesHost("0.1.29", range), false);
  const a = fixture(), b = fixture("0.2.0"), latest = fixture("9.0.0"); latest.release.piWebapp.hostRange = ">=9.0.0";
  const metadata = {versions:{"0.1.0":a.release,"0.2.0":b.release,"9.0.0":latest.release,"10.0.0-beta.1":{...b.release,version:"10.0.0-beta.1"}}};
  assert.equal(selectRelease(metadata, OFFICIAL_PLUGINS[0]!, "0.1.29").version, "0.2.0");
  assert.throws(() => selectRelease(metadata, OFFICIAL_PLUGINS[0]!, "0.1.29", "0.2.0", "0.1.0"), code("no_compatible_version"));
});

test("alpha hosts retain prerelease precedence while plugin selection stays stable-only", async t => {
  const root = await temporary(t), hostVersion = "0.1.31-alpha.5", f = fixture();
  const installer = new HostedPluginInstaller({ root, hostVersion });
  assert.equal(installer.hostVersion, hostVersion, "Keep the exact release identity, never coerce to stable");
  for (const range of [">=0.1.0 <1.0.0", "^0.1.20", "~0.1.0", "<0.1.31"]) assert.equal(satisfiesHost(hostVersion, range), true, range);
  for (const range of [">=0.1.31", "0.1.31", "^0.1.31", ">=1.0.0", "*", ">=0.1.0 || *"]) assert.equal(satisfiesHost(hostVersion, range), false, range);
  for (const invalid of ["0.1.31-alpha.05", "0.1.31-alpha", "0.1.31-beta.1", "0.1.31-alpha.1+build", "v0.1.31", "latest", "0.1.31\n"]) {
    assert.throws(() => new HostedPluginInstaller({ root, hostVersion: invalid }), code("invalid_version"));
    assert.equal(satisfiesHost(invalid, ">=0.1.0 <1.0.0"), false, invalid);
  }
  const metadata = { versions: { "0.1.0": f.release, "0.2.0-alpha.1": fixture("0.2.0-alpha.1").release } };
  assert.equal(selectRelease(metadata, OFFICIAL_PLUGINS[0]!, hostVersion).version, "0.1.0");
  await installer.installArchive(id, f.bytes, sri(f.bytes), "0.1.0");
  assert.equal((await new HostedPluginInstaller({ root, hostVersion }).load(id, "0.1.0")).version, "0.1.0");
  await assert.rejects(installer.check(id, undefined, "0.2.0-alpha.1"), code("invalid_version"));
  const incompatible = fixture("0.2.0"); incompatible.entries[0]!.content = incompatible.entries[0]!.content!.replace(">=0.1.0 <1.0.0", ">=0.1.31");
  const bytes = tar(incompatible.entries);
  await assert.rejects(installer.installArchive(id, bytes, sri(bytes), "0.2.0"), code("incompatible_plugin"));
});

test("host coordination preserves absent/disabled/pinned intent, offline compatible code and no downgrades", () => {
  const base = {installed:true,enabled:false,policy:"automatic" as const,currentCompatible:true,currentVersion:"0.1.0",recommendedVersion:"0.2.0",networkAvailable:true};
  assert.deepEqual(hostUpdateDecision(base), {action:"update",enabled:false});
  assert.deepEqual(hostUpdateDecision({...base,installed:false}), {action:"none",enabled:false});
  assert.equal(hostUpdateDecision({...base,policy:"pinned"}).action,"update");
  assert.equal(hostUpdateDecision({...base,policy:"pinned",trigger:"independent"}).action,"keep");
  assert.equal(hostUpdateDecision({...base,networkAvailable:false}).action,"keep");
  assert.deepEqual(hostUpdateDecision({...base,enabled:true,currentCompatible:false,networkAvailable:false}), {action:"disable-incompatible",enabled:false});
  assert.equal(hostUpdateDecision({...base,currentVersion:"1.0.0"}).action,"keep");
});

test("tar rejects traversal, absolute/windows paths, links, duplicates and ancestor collisions before writes", () => {
  const f = fixture(); assert.equal(archiveMembers(f.bytes).length, 4);
  for (const path of ["package/../outside", "/package/a", "C:/package/a", "package/a\\b", "package//bad", "another/a"])
    assert.throws(() => archiveMembers(tar([...f.entries, {path,content:"bad"}])) ,code("invalid_archive"));
  for (const type of ["1", "2", "3", "4", "6", "S", "g"]) assert.throws(() => archiveMembers(tar([...f.entries, {path:"package/bad",type,link:"../../outside"}])), code("invalid_archive"));
  assert.throws(() => archiveMembers(tar([...f.entries, f.entries[0]!])), /Duplicate/);
  assert.throws(() => archiveMembers(tar([...f.entries,{path:"package/a",content:"file"},{path:"package/a/b",content:"bad"}])) , /collision/);
  assert.throws(() => archiveMembers(Buffer.from("not gzip")), code("invalid_archive"));
});

test("SHA-512 required; partial/corrupted archives cannot register or overwrite installed code", async t => {
  const root = await temporary(t), i = new HostedPluginInstaller({root,hostVersion:"0.1.29"}), f = fixture();
  assert.throws(() => verifyArchiveIntegrity(f.bytes,"sha1-bad"), code("invalid_integrity"));
  await assert.rejects(i.installArchive(id,Buffer.from("bad"),sri(f.bytes),"0.1.0"),code("integrity_mismatch"));
  assert.deepEqual((await i.inventory()).versions,{});
  const pkg = await i.installArchive(id,f.bytes,sri(f.bytes),"0.1.0");
  const again = await i.installArchive(id,f.bytes,sri(f.bytes),"0.1.0"); assert.equal(again.root,pkg.root);
  assert.equal((await i.inventory()).versions[id]?.length,1);
  const modified = fixture("0.1.0"); modified.entries[3]!.content = "changed"; const bad = tar(modified.entries);
  await assert.rejects(i.installArchive(id,bad,sri(bad),"0.1.0"), /integrity/);
  assert.equal((await i.load(id,"0.1.0")).digest,pkg.digest);
  assert.deepEqual(await readdir(join(root,"staging")),[]);
});

test("installer refuses scripts, runtime deps, changed immutable versions, unexpected identity/version and cancellation", async t => {
  const root = await temporary(t), i = new HostedPluginInstaller({root,hostVersion:"0.1.29"}), f = fixture();
  await i.installArchive(id,f.bytes,sri(f.bytes),"0.1.0");
  for (const extra of [{scripts:{postinstall:"must-not-run"}},{dependencies:{evil:"*"}},{name:"@wrong/plugin"}]) {
    const bad = fixture("0.2.0",extra); await assert.rejects(i.installArchive(id,bad.bytes,sri(bad.bytes),"0.2.0"));
  }
  const modified = fixture("0.1.0"); const document = modified.entries.find(e=>e.path.endsWith("package.json"))!;
  const m = JSON.parse(document.content!); m.piWebapp.capabilities.push("extra"); document.content = JSON.stringify(m);
  const bytes = tar(modified.entries); await assert.rejects(i.installArchive(id,bytes,sri(bytes),"0.1.0"),code("version_replaced"));
  await assert.rejects(i.installArchive(id,f.bytes,sri(f.bytes),"0.2.0"),code("incompatible_plugin"));
  const abort = new AbortController(); abort.abort();
  await assert.rejects(i.installArchive(id,f.bytes,sri(f.bytes),"0.1.0",abort.signal), {name:"AbortError"});
  assert.equal((await i.inventory()).versions[id]?.length,1);
});

test("registry transport prohibits cross-origin tarballs/redirects and bounds download; offline load has no network", async t => {
  const root = await temporary(t), f = fixture(); let calls = 0;
  const fetcher: typeof fetch = async (_url,init) => { calls++; assert.equal(init?.redirect,"error"); return new Response(JSON.stringify({versions:{"0.1.0":f.release}})); };
  const i = new HostedPluginInstaller({root,hostVersion:"0.1.29",fetch:fetcher});
  assert.equal((await i.check(id)).version,"0.1.0");
  await assert.rejects(i.install(id,{...f.release,dist:{...f.release.dist,tarball:"https://evil.test/plugin.tgz"}}),code("registry_denied"));
  assert.equal(calls,1);
  await i.installArchive(id,f.bytes,sri(f.bytes),"0.1.0");
  await i.load(id,"0.1.0"); assert.equal(calls,1);
  const oversized = new HostedPluginInstaller({root,hostVersion:"0.1.29",fetch:async()=>new Response("{}",{headers:{"content-length":"999999999"}})});
  await assert.rejects(oversized.check(id),code("download_too_large"));
});

test("install journal recovery keeps atomic index authoritative; uninstall removes only selected code", async t => {
  const root = await temporary(t), i = new HostedPluginInstaller({root,hostVersion:"0.1.29"}), f = fixture();
  await i.installArchive(id,f.bytes,sri(f.bytes),"0.1.0"); const record = (await i.inventory()).versions[id]![0]!;
  await writeFile(join(root,"install-journal.json"),JSON.stringify({schema:1,pluginId:id,next:record}));
  assert.equal((await i.inventory()).versions[id]?.length,1);
  const userFile = join(root,"user.excalidraw"); await writeFile(userFile,"keep");
  await i.removeVersions(id,["0.1.0"]); assert.equal((await i.inventory()).versions[id]?.length,0);
  assert.equal(await readFile(userFile,"utf8"),"keep");
  await assert.rejects(i.load(id,"0.1.0"),code("not_installed"));
});

test("legacy checkpoint import aggregates exact scope, fences builtin writer under lock and preserves bytes", async t => {
  const root = await temporary(t), sessionId = "session";
  const draft = await writeLegacyCheckpoint(root,root,sessionId);
  const folder = join(root,sha256(JSON.stringify([root,sessionId]))), original = await readFile(join(folder,draft.id+".json"));
  const loader = legacyCheckpointLoader(root);
  const r = {requestId:randomUUID(),generation:1,scope:{cwd:root,sessionId,workspaceId:"workspace"},kind:"action" as const,action:"get",input:{}};
  const imported = await loader(r) as {drafts:unknown[];focused:string}; assert.equal(imported.drafts.length,1); assert.equal(imported.focused,draft.id);
  await assert.rejects(writeLegacyCheckpoint(root,root,sessionId),e=>(e as {reason?:string}).reason === "diagram_migrated");
  assert.deepEqual(await readFile(join(folder,draft.id+".json")),original);
  assert.deepEqual(await loader(r),imported);
  assert.equal((await loader({...r,scope:{...r.scope,sessionId:"other"}}) as {drafts:unknown[]}).drafts.length,0);
});

test("domain RPC failures retain status/reason rather than treating unavailable drawings as generic failures", () => {
  assert.deepEqual(failure(Object.assign(new Error("missing"),{status:404,reason:"diagram_unavailable"})),{code:"plugin_failed",message:"missing",status:404,reason:"diagram_unavailable"});
  assert.deepEqual(failure(Object.assign(new Error("bad"),{status:200,reason:"invalid reason"})),{code:"plugin_failed",message:"bad"});
});
