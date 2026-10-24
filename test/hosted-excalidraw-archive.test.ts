import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { HostedPluginManager } from "../src/host/server/plugins/hosted/manager.ts";
import { legacyCheckpointLoader } from "../src/host/server/plugins/hosted/legacy-checkpoints.ts";
import { writeLegacyCheckpoint } from "./helpers/legacy-checkpoint.ts";

/** Cross-repo artifact supplied explicitly, never silently resolved from sibling node_modules. */
test("exact external Excalidraw tgz: install, import, edit, save, drain, restart, disable and uninstall preserve data", { skip: !process.env.HOSTED_EXCALIDRAW_TGZ }, async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-excalidraw-archive-"));
  const cwd = join(root,"workspace"); await mkdir(cwd);
  const workerEntry = join(root,"worker.mjs");
  await build({entryPoints:[new URL("../src/host/server/plugins/hosted/worker-entry.ts",import.meta.url).pathname],outfile:workerEntry,bundle:true,platform:"node",format:"esm",logLevel:"silent"});
  const id = "@chengzhiyi/pi-excalidraw", scope = {cwd,workspaceId:"workspace",sessionId:"session"};
  const legacyRoot = join(root,"legacy");
  const old = await writeLegacyCheckpoint(legacyRoot,cwd,scope.sessionId);
  const nativeBytes = Buffer.from(JSON.stringify(old.scene)+"\n");
  await writeFile(join(cwd,"original.excalidraw"),nativeBytes);
  const rich = {...old,scene:{...old.scene,elements:[{id:"hand",type:"rectangle",x:999,y:30,width:200,height:100,groupIds:["核心层"]}]},id:"saved-historical",revision:7,savedRevision:5,path:"original.excalidraw",diskHash:createHash("sha256").update(nativeBytes).digest("hex"),candidate:{id:"stale-candidate",baseRevision:6,patch:{removeIds:["gone"]}}};
  await writeLegacyCheckpoint(legacyRoot,cwd,scope.sessionId,rich);
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
  const list = await invoke("list") as Array<{id:string}>; assert.ok(list.some(d=>d.id===old.id));
  assert.deepEqual(await invoke("get",{id:rich.id}),rich);
  assert.equal((await invoke("read",{},"tool") as {id:string}).id,rich.id);
  await assert.rejects(invoke("accept",{id:rich.id,revision:7,candidateId:rich.candidate.id,scene:old.scene}),/旧图稿/);
  assert.deepEqual(await readFile(join(cwd,"original.excalidraw")),nativeBytes);
  await assert.rejects(writeLegacyCheckpoint(legacyRoot,cwd,scope.sessionId),e=>(e as {reason?:string}).reason==="diagram_migrated");
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
  assert.deepEqual(await invoke("get",{id:rich.id}),rich);
  await manager.manage(id,"disable"); assert.equal(manager.tools.length,0);
  await manager.manage(id,"uninstall"); assert.equal((await manager.inventory()).plugins[0]!.installed,false);
  assert.deepEqual(await readFile(join(cwd,"diagrams/中文.excalidraw")),file);
  await manager.installer.installArchive(id,bytes,integrity,"0.1.0"); await manager.manage(id,"enable");
  assert.equal((await invoke("read",{id:old.id},"tool") as {revision:number}).revision,1);
  assert.deepEqual(await invoke("get",{id:rich.id}),rich);
  assert.deepEqual(await readFile(join(cwd,"original.excalidraw")),nativeBytes);
  assert.equal(freezes>0,true); assert.equal(commits>0,true);
});
