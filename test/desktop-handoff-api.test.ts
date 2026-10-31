import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBridge } from "../src/host/server/transport/bridge.ts";
import { terminalHost } from "./helpers/terminal-host.ts";
import { SelfUpdater } from "../src/host/server/updates/self-update.ts";

const nonce = "old-owner", requestId = "d54ab3a0-895d-4fa3-9317-ce1c2ed41b33";
async function updaterFixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pi-handoff-api-"));t.after(() => rm(root, {recursive:true,force:true}));
  const packageRoot = join(root, "package");await mkdir(packageRoot);await mkdir(join(root,"pi-web"));
  await writeFile(join(packageRoot,"package.json"),JSON.stringify({name:"pi-webapp",version:"0.1.46"}));
  const statePath=join(root,"pi-web/launcher.json");const owner={pid:12345,nonce,runtimeKind:"desktop",launcherHandoffProtocol:1};
  await writeFile(statePath,JSON.stringify(owner));
  const saved=process.env.PI_WEBAPP_LAUNCHER_HANDOFF_PROTOCOL;process.env.PI_WEBAPP_LAUNCHER_HANDOFF_PROTOCOL="1";
  t.after(()=> { if(saved===undefined)delete process.env.PI_WEBAPP_LAUNCHER_HANDOFF_PROTOCOL;else process.env.PI_WEBAPP_LAUNCHER_HANDOFF_PROTOCOL=saved; });
  return {root,packageRoot,statePath,owner};
}

test("handoff writes a request only after real hosted drain and exact owner validation", async t=>{
  const f=await updaterFixture(t);let drained=false;
  const updater=new SelfUpdater({agentDir:f.root,packageRoot:f.packageRoot,launcherNonce:nonce,desktopManaged:true,beforeRestart:async()=>{drained=true;}});
  await assert.rejects(updater.requestLauncherHandoff("wrong-owner",requestId));assert.equal(drained,false);
  await updater.requestLauncherHandoff(nonce,requestId);assert.equal(drained,true);
  assert.deepEqual(JSON.parse(await readFile(join(f.root,"pi-web/launcher-handoff.json"),"utf8")),{protocol:1,pid:f.owner.pid,nonce,requestId,phase:"requested"});
  await assert.rejects(readFile(join(f.root,"pi-web/launcher.stop")),{code:"ENOENT"});
});

for(const failure of ["save", "owner"] as const)test(`failed ${failure} leaves no handoff marker and resumes an acquired drain lease`,async t=>{
  const f=await updaterFixture(t);let restored=0;
  const updater=new SelfUpdater({agentDir:f.root,packageRoot:f.packageRoot,launcherNonce:nonce,desktopManaged:true,beforeRestart:async()=>{
    if(failure==="save")throw Error("save not confirmed");
    await writeFile(f.statePath,JSON.stringify({...f.owner,nonce:"replacement"}));return async()=>{restored++;};
  }});
  await assert.rejects(updater.requestLauncherHandoff(nonce,requestId));assert.equal(restored,failure==="owner"?1:0);
  await assert.rejects(readFile(join(f.root,"pi-web/launcher-handoff.json")),{code:"ENOENT"});
});

for(const busy of ["current", "background", "terminal"] as const)test(`HTTP handoff refuses ${busy} activity before requesting a drain`,async t=>{
  const {host}=terminalHost();let calls=0;const snapshot=host.snapshot();
  if(busy==="current")host.snapshot=()=>({...snapshot,idle:false});
  if(busy==="background")host.busyGitWorkspaces=()=>["/background-chat"];
  host.selfUpdate={runningVersion:async()=>"0.1.46",check:async()=>({current:"0.1.46",latest:null,available:false,canRestart:true}),prepare:async()=>{throw Error("unexpected install");},requestRestart:async()=>{},requestLauncherHandoff:async()=>{calls++;}};
  const bridge=await startBridge(host,new URL("../web/dist",import.meta.url).pathname);t.after(()=>bridge.close());const u=new URL(bridge.url);
  const post=(path:string,body:object)=>fetch(u.origin+path,{method:"POST",headers:{Authorization:`Bearer ${u.hash.slice(1)}`,Origin:u.origin,"Content-Type":"application/json"},body:JSON.stringify(body)});
  if(busy==="terminal"){
    const r=await post("/api/terminal/create",{sessionId:snapshot.sessionId,id:"03ad94c1-c9b1-473e-a8cd-094b6b9cd492",cols:80,rows:24});assert.equal(r.status,201,await r.text());
  }
  const r=await post("/api/desktop/handoff",{nonce,requestId});assert.equal(r.status,409,await r.text());assert.equal(calls,0);
});

test("HTTP handoff locks mutation admission during drain and reopens it after refusal",async t=>{
  const {host}=terminalHost();let reject!: (e:Error)=>void;let entered!:()=>void;const entry=new Promise<void>(r=>entered=r);
  host.selfUpdate={runningVersion:async()=>"0.1.46",check:async()=>({current:"0.1.46",latest:null,available:false,canRestart:true}),prepare:async()=>{throw Error("unexpected");},requestRestart:async()=>{},requestLauncherHandoff:async()=>{entered();await new Promise<void>((_,r)=>reject=r);}};
  const bridge=await startBridge(host,new URL("../web/dist",import.meta.url).pathname);t.after(()=>bridge.close());const u=new URL(bridge.url);
  const post=(path:string,body:object)=>fetch(u.origin+path,{method:"POST",headers:{Authorization:`Bearer ${u.hash.slice(1)}`,Origin:u.origin,"Content-Type":"application/json"},body:JSON.stringify(body)});
  const pending=post("/api/desktop/handoff",{nonce,requestId});await entry;
  const denied=await post("/api/new-session",{sessionId:host.snapshot().sessionId});assert.equal(denied.status,409);
  reject(Error("save confirmation refused"));assert.equal((await pending).status,400);
  assert.equal((await post("/api/new-session",{sessionId:host.snapshot().sessionId})).status,202);
});
