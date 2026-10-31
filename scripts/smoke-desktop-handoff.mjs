// Real SDK/bridge/terminal and launcher handoff in a private agent directory.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {DesktopBackend,alive} from '../desktop/backend.mjs';
const root=await mkdtemp(join(tmpdir(),'pi-real-launcher-handoff-')),agent=join(root,'agent');await mkdir(agent);
const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
const release=JSON.parse(await readFile(new URL('../desktop/release.json',import.meta.url),'utf8'));
const runtime=resolve('.desktop/runtime'),node=join(runtime,process.platform==='win32'?'node/node.exe':'node/bin/node'),launcher=join(runtime,'backend/bin/pi-webapp.mjs'),piCli=join(runtime,'backend/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'),npmCli=join(runtime,process.platform==='win32'?'node/node_modules/npm/bin/npm-cli.js':'node/lib/node_modules/npm/bin/npm-cli.js');
const env={...process.env,PI_CODING_AGENT_DIR:agent,PI_WEB_SENTRY_ENABLED:'false',PI_WEBAPP_AUTO_OPEN:'0',PI_WEBAPP_RUNTIME:'desktop',PI_WEBAPP_DESKTOP_PACKAGE_UPDATES:'1',PI_WEBAPP_DESKTOP_RELEASE_CHANNELS:'0',PI_WEBAPP_DESKTOP_VERSION:'0.1.28',PI_WEBAPP_DESKTOP_BUILD:'10',PI_WEBAPP_PI_CLI:piCli,npm_execpath:npmCli};
const original=spawn(node,[launcher,'__serve',node],{cwd:root,env,stdio:['ignore','ignore','ignore','ipc']});
const ready=await new Promise((ok,no)=>{const timeout=setTimeout(()=>no(Error('real predecessor startup timeout')),70000);original.on('message',x=>{clearTimeout(timeout);x.type==='ready'?ok(x):no(Error('predecessor did not become ready'));});original.on('error',no);});original.disconnect();
const stateFile=join(agent,'pi-web/launcher.json'),before=JSON.parse(await readFile(stateFile,'utf8'));const u=new URL(before.url);const headers={Authorization:`Bearer ${u.hash.slice(1)}`,Origin:u.origin,'Content-Type':'application/json'};
const post=async(path,body)=>{const r=await fetch(u.origin+path,{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(45000)});return {http:r.status,body:await r.json()};};
const get=async(path)=>{const r=await fetch(u.origin+path,{headers,signal:AbortSignal.timeout(15000)});assert.equal(r.status,200);return r.json();};
const client=new DesktopBackend({agentDir:agent,version:pkg.version,node,launcher,piCli,npmCli,cwd:root,env:{...env,PI_WEBAPP_DESKTOP_VERSION:pkg.version,PI_WEBAPP_DESKTOP_BUILD:String(release.buildNumber)}});
let passed=false;
try {
 await client.connect();assert.equal(client.owned,false);assert.equal(before.desktopReleaseChannels,false);
 const session=await get('/api/session'),id=randomUUID();assert.equal((await post('/api/terminal/create',{sessionId:session.sessionId,id,cols:80,rows:24})).http,201);
 await assert.rejects(client.handoff(),/终端/);assert.ok(alive(before.pid));
 assert.equal((await post('/api/terminal/close',{sessionId:session.sessionId,id})).http,200);
 assert.equal((await post('/api/update/channel',{sessionId:session.sessionId,channel:'alpha'})).http,200);
 const after=await client.handoff();assert.equal(after.url,before.url);assert.equal(alive(before.pid),false);assert.equal(after.desktopReleaseChannels,true);assert.equal(after.desktopShell.build,String(release.buildNumber));
 const version=await get('/api/update/version');assert.equal(version.launcher.releaseChannels,true);assert.equal(version.launcher.desktopShell.build,String(release.buildNumber));
 assert.equal((await get('/api/update')).channel,'alpha');
 const restarted=await client.handoff();assert.equal(restarted.url,before.url);assert.equal(restarted.version,after.version);assert.equal((await get('/api/update')).channel,'alpha');
 await mkdir('artifacts/desktop',{recursive:true});await writeFile('artifacts/desktop/handoff-result.json',JSON.stringify({passed:true,terminalRefused:true,oldExitedNaturally:true,sameOriginAndToken:true,capabilitiesVerifiedOverHTTP:true,channelSurvivedBackendRestart:true,version:restarted.version,desktopBuild:release.buildNumber},null,2));passed=true;
} finally {
 try {const state=JSON.parse(await readFile(stateFile,'utf8'));await post('/api/desktop/handoff',{nonce:state.nonce,requestId:randomUUID()});for(let i=0;i<700&&alive(state.pid);i++)await delay(100);assert.equal(alive(state.pid),false);await rm(root,{recursive:true,force:true});}catch(e){console.error('fixture cleanup needs inspection',root,e.message);process.exitCode=1;}
}
assert.ok(passed);console.log('Real predecessor → build 14 handoff, terminal refusal, same URL/token and alpha channel persistence: PASS');
