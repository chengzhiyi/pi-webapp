import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, rm, symlink, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { legacyCheckpointLoader } from "../src/host/server/plugins/hosted/legacy-checkpoints.ts";
import { legacyDraft, legacyFolder, writeLegacyCheckpoint } from "./helpers/legacy-checkpoint.ts";

async function fixture(t: {after(fn:()=>Promise<void>):void}) {
  const root=await mkdtemp(join(tmpdir(),"opaque-legacy-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const request={requestId:"migration",generation:1,scope:{cwd:"/workspace",workspaceId:"trusted",sessionId:"session"},kind:"action" as const,action:"list",input:{}};
  const folder=legacyFolder(root,request.scope.cwd,request.scope.sessionId);
  await writeLegacyCheckpoint(root,request.scope.cwd,request.scope.sessionId);
  return {root,request,folder,load:legacyCheckpointLoader(root)};
}
test("opaque migration preserves original bytes/unknown domain metadata and fences writer without stealing a live lock",async t=>{
  const {root,request,folder,load}=await fixture(t), path=join(folder,legacyDraft.id+".json");
  const envelope=JSON.parse(await readFile(path,"utf8"));envelope.draft.opaqueFutureMetadata={keep:true};
  await writeFile(path,JSON.stringify(envelope));const before=await readFile(path);
  await writeFile(join(folder,"scope.lock"),"old-owner");
  await assert.rejects(load(request), /Legacy drawing writer/);
  assert.equal(await readFile(join(folder,"scope.lock"),"utf8"),"old-owner");
  await rm(join(folder,"scope.lock")); // explicit test operator after owner stopped
  assert.deepEqual(await load(request),{drafts:[envelope.draft],focused:legacyDraft.id});
  assert.deepEqual(await readFile(path),before);
  await assert.rejects(writeLegacyCheckpoint(root,request.scope.cwd,request.scope.sessionId),/fenced/);
  assert.deepEqual(await load({...request,scope:{...request.scope,cwd:"/other-workspace"}}),{drafts:[],focused:null});
  assert.deepEqual(await load({...request,scope:{...request.scope,sessionId:"other-session"}}),{drafts:[],focused:null});
});
test("corrupt/scope-mismatched/oversized/linked legacy envelopes fail closed, preserve bytes and release only their own lock",async t=>{
  const {root,request,folder,load}=await fixture(t), path=join(folder,legacyDraft.id+".json");
  const original=await readFile(path);
  for(const contents of ["{broken",JSON.stringify({version:1,cwd:"/wrong",sessionId:"session",draft:legacyDraft})," ".repeat(3*512*1024+1)]) {
    await writeFile(path,contents);await assert.rejects(load(request));assert.equal(await readFile(path,"utf8"),contents);
    assert.ok(!(await readdir(folder)).includes("scope.lock"));assert.ok(!(await readdir(folder)).includes("hosted-migration.json"));
  }
  await writeFile(path,original);await writeFile(join(folder,"focus.json"),JSON.stringify("not-a-draft"));await assert.rejects(load(request),/focused/);
  await writeFile(join(folder,"focus.json"),JSON.stringify(legacyDraft.id));
  await rm(path);const outside=join(root,"original.json");await writeFile(outside,original);await symlink(outside,path);await assert.rejects(load(request));assert.deepEqual(await readFile(outside),original);
  const linked=legacyFolder(root,"/workspace","linked");await symlink(folder,linked);
  await assert.rejects(load({...request,scope:{...request.scope,sessionId:"linked"}}));
});
