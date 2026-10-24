import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { HostedPluginManager } from "../src/host/server/plugins/hosted/manager.ts";
import { legacyCheckpointLoader } from "../src/host/server/plugins/hosted/legacy-checkpoints.ts";
import { PersistentDiagramStore } from "../src/plugins/builtin/diagrams/server/persistence.ts";

/** Cross-repo artifact supplied explicitly, never silently resolved from sibling node_modules. */
test("exact external Excalidraw tgz: install, import, edit, save, drain, restart, disable and uninstall preserve data", { skip: !process.env.HOSTED_EXCALIDRAW_TGZ }, async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-excalidraw-archive-"));
  const cwd = join(root,"workspace"); await mkdir(cwd);
  const workerEntry = join(root,"worker.mjs");
  await build({entryPoints:[new URL("../src/host/server/plugins/hosted/worker-entry.ts",import.meta.url).pathname],outfile:workerEntry,bundle:true,platform:"node",format:"esm",logLevel:"silent"});
  const id = "@chengzhiyi/pi-excalidraw", scope = {cwd,workspaceId:"workspace",sessionId:"session"};
  const legacyRoot = join(root,"legacy"), legacy = new PersistentDiagramStore(legacyRoot);
  const old = await legacy.action(cwd,scope.sessionId,"new",{},()=>{}) as { id:string; scene:unknown; revision:number };
  const options = {root:join(root,"hosted"),hostVersion:"0.1.29",workerEntry,
    legacy:()=>legacyCheckpointLoader(legacyRoot),
    async lifecycle<T>(_id: string, operation: () => Promise<T>): Promise<T> {
      assert.equal(inLifecycle,false); inLifecycle = true; lifecycleEntries++;
      try { return await operation(); } finally { inLifecycle = false; }
    },
    hooks:()=>({canSwitch:()=>!editorOpen,validateCandidate:(tools: readonly {name:string}[])=>{assert.equal(inLifecycle,true);assert.equal(tools.length,6)},freeze:async()=>{assert.equal(inLifecycle,true);freezes++},committed:async()=>{commits++},resume:async()=>{}}),
    fetch:async()=>{throw new Error("Offline test must not contact registry")},
  };
  let editorOpen = false, freezes = 0, commits = 0, lifecycleEntries = 0, inLifecycle = false;
  let manager = new HostedPluginManager(options);
  t.after(async () => { try { await manager.shutdown(); } finally { await rm(root, { recursive: true, force: true }); } });
  await manager.start(); assert.equal((await manager.inventory()).plugins[0]!.installed,false);
  const bytes = await readFile(process.env.HOSTED_EXCALIDRAW_TGZ!);
  const integrity = "sha512-"+createHash("sha512").update(bytes).digest("base64");
  const pkg = await manager.installer.installArchive(id,bytes,integrity,"0.1.0");
  assert.equal(pkg.resources.size,426);
  assert.equal(manager.tools.length,0); assert.equal(lifecycleEntries,0); // Download/verify never freezes Agent sessions.
  await manager.manage(id,"enable"); assert.equal(manager.tools[0]!.descriptors.length,6);
  const assetView = (await manager.inventory()).plugins[0]!;
  const assetUrl = assetView.assetBase! + assetView.document!;
  assert.equal((await manager.assetRequest(assetUrl))?.mime,"text/html");
  assert.equal(await manager.assetRequest(assetView.assetBase! + "dist/runtime.js"),null);
  assert.equal(await manager.assetRequest(assetUrl.replace(/\/([A-Za-z0-9_-]{32})\//,"/"+"x".repeat(32)+"/")),null);
  const generation = () => manager.tools[0]!.generation;
  const invoke = (action:string,input:unknown={},kind:"action"|"tool"="action") => manager.invoke(id,generation(),{requestId:randomUUID(),scope,kind,action,input});
  const list = await invoke("list") as Array<{id:string}>; assert.equal(list[0]?.id,old.id);
  await assert.rejects(legacy.action(cwd,scope.sessionId,"new",{},()=>{}),e=>(e as {reason?:string}).reason==="diagram_migrated");
  const edited = await invoke("sync",{id:old.id,revision:0,scene:old.scene}) as {id:string;revision:number}; assert.equal(edited.revision,1);
  const saved = await invoke("save",{id:old.id,revision:1,path:"diagrams/中文.excalidraw"}) as {diskHash:string;revision:number};
  const file = await readFile(join(cwd,"diagrams/中文.excalidraw")); assert.equal(createHash("sha256").update(file).digest("hex"),saved.diskHash);
  await assert.rejects(invoke("get",{id:"missing"}), e=>(e as {status?:number;reason?:string}).status===404 && (e as {reason?:string}).reason==="diagram_unavailable");
  const oldGeneration = generation();
  editorOpen = true; assert.deepEqual(await manager.manage(id,"enable"),{pending:true}); assert.equal(generation(),oldGeneration);
  editorOpen = false; await manager.manage(id,"retry"); assert.equal(generation(),oldGeneration+1);
  assert.equal(await manager.assetRequest(assetUrl),null); // Old generation capability is revoked.
  await assert.rejects(manager.invoke(id,oldGeneration,{requestId:randomUUID(),scope,kind:"action",action:"sync",input:{id:old.id,revision:1,scene:old.scene}}), e=>(e as {code?:string}).code==="stale_generation");
  assert.equal((await invoke("read",{id:old.id},"tool") as {revision:number}).revision,1);
  await manager.shutdown(); manager = new HostedPluginManager(options); await manager.start();
  assert.equal((await invoke("read",{id:old.id},"tool") as {revision:number}).revision,1);
  await manager.manage(id,"disable"); assert.equal(manager.tools.length,0);
  await manager.manage(id,"uninstall"); assert.equal((await manager.inventory()).plugins[0]!.installed,false);
  assert.deepEqual(await readFile(join(cwd,"diagrams/中文.excalidraw")),file);
  await manager.installer.installArchive(id,bytes,integrity,"0.1.0"); await manager.manage(id,"enable");
  assert.equal((await invoke("read",{id:old.id},"tool") as {revision:number}).revision,1);
  assert.equal(freezes>0,true); assert.equal(commits>0,true);
});
