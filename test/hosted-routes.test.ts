import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBridge } from "../src/host/server/transport/bridge.ts";
import { terminalHost } from "./helpers/terminal-host.ts";
import { NodeTelemetry } from "../src/platform/telemetry/telemetry.ts";
import { HostedPluginError } from "../src/host/server/plugins/hosted/errors.ts";
import { hostedApi } from "../src/host/server/plugins/hosted/routes.ts";

test("hosted production HTTP routes require bearer/origin, preserve domain errors and keep parent CSP unchanged", async t => {
  const root = await mkdtemp(join(tmpdir(),"pi-hosted-routes-")), {host} = terminalHost(root);
  let action: unknown, managed: unknown;
  host.hosted = {
    inventory:async()=>({plugins:[{id:"@example/plugin",installed:false}],errors:[]}),
    manage:async input=>{managed=input;return {installed:true}},
    action:async input=>{action=input; if(input.action==="get") throw new HostedPluginError("plugin_failed","missing",{status:404,reason:"diagram_unavailable"}); return {ok:true}},
    views:async input=>({viewId:input.viewId}),
    asset:async path=>path.includes("capability") ? {mime:"text/html",bytes:Buffer.from("<html>frame</html>")} : null,
  };
  const bridge = await startBridge(host,new URL("../web/dist",import.meta.url).pathname,new NodeTelemetry({env:{PI_WEB_SENTRY_ENABLED:"false"},monitor:false}),{pluginSettingsFile:join(root,"preferences.json")});
  t.after(async()=>{await bridge.close();await rm(root,{recursive:true,force:true})});
  const url = new URL(bridge.url), headers = {Authorization:`Bearer ${url.hash.slice(1)}`,Origin:url.origin,"Content-Type":"application/json"};
  const post = (path:string,body:unknown,extra:Record<string,string>={})=>fetch(url.origin+path,{method:"POST",headers:{...headers,...extra},body:JSON.stringify(body)});
  assert.equal((await fetch(url.origin+"/api/hosted-plugins")).status,401);
  assert.equal((await fetch(url.origin+"/api/hosted-plugins",{headers})).status,200);
  const manage = {pluginId:"@example/plugin",operation:"install",cwd:"/untrusted",workspaceId:"forged"};
  assert.equal((await post("/api/hosted-plugins/manage",manage,{Origin:"https://other.invalid"})).status,403);
  assert.equal((await post("/api/hosted-plugins/manage",manage,{Authorization:"Bearer wrong"})).status,401);
  assert.equal((await post("/api/hosted-plugins/manage",{...manage,operation:"arbitrary"})).status,400);
  assert.equal((await post("/api/hosted-plugins/manage",manage)).status,200);
  assert.deepEqual(managed,{pluginId:"@example/plugin",operation:"install"});
  const input = {sessionId:"session",pluginId:"@example/plugin",generation:1,action:"list",input:{},cwd:"/forged"};
  assert.equal((await post("/api/hosted-plugins/action",input)).status,200);
  assert.deepEqual(action,{sessionId:"session",pluginId:"@example/plugin",generation:1,action:"list",input:{}});
  const missing = await post("/api/hosted-plugins/action",{...input,action:"get"}); assert.equal(missing.status,404);
  assert.equal((await missing.json()).reason,"diagram_unavailable");
  assert.equal((await post("/api/hosted-plugins/action",{...input,generation:0})).status,400);
  const parent = await fetch(url.origin); assert.match(parent.headers.get("Content-Security-Policy")!,/frame-ancestors 'none'/);
  const frame = await fetch(url.origin+"/hosted-plugins/capability/frame.html"); assert.equal(frame.status,200);
  assert.match(frame.headers.get("Content-Security-Policy")!,/frame-ancestors 'self'/);
  assert.doesNotMatch(frame.headers.get("Content-Security-Policy")!,/unsafe-eval/);
  assert.equal((await fetch(url.origin+"/hosted-plugins/unknown/frame.html")).status,404);
});

test("unwired hosted runtime fails explicitly without falling back to v1 reload/install", async()=>{
  await assert.rejects(hostedApi(undefined,"/api/hosted-plugins",undefined),e=>(e as {code?:string}).code==="hosted_unavailable");
});
