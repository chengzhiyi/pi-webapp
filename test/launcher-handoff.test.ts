import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { writeHandoff, readHandoff } from "../desktop/launcher-handoff.mjs";

test("actual supervisor handoff waits beyond the normal force-stop timeout and never signals its child", {timeout:20000}, async()=>{
  const agentDir=await mkdtemp(join(tmpdir(),"pi-safe-handoff-"));const fake=join(agentDir,"pi.mjs"), marker=join(agentDir,"sigterm");
  await writeFile(fake, `import {createInterface} from 'node:readline'; import {writeFileSync} from 'node:fs';
const lines=createInterface({input:process.stdin});
lines.on('line',line=>{const r=JSON.parse(line);if(r.type==='get_commands')console.log(JSON.stringify({type:'response',id:r.id,success:true,data:{commands:[{name:'web',source:'extension',sourceInfo:{path:process.argv[5]}}]}}));else console.log(JSON.stringify({type:'extension_ui_request',method:'notify',message:'pi-webapp: http://127.0.0.1:12345/#${"a".repeat(32)}'}));});
lines.on('close',()=>setTimeout(()=>process.exit(0),5600));setInterval(()=>{},1000);
process.on('SIGTERM',()=>{writeFileSync(${JSON.stringify(marker)},'signalled');process.exit(9);});`);
  const supervisor=spawn(process.execPath,[new URL('../bin/pi-webapp.mjs',import.meta.url).pathname,'__serve',process.execPath],{env:{...process.env,PI_CODING_AGENT_DIR:agentDir,PI_WEBAPP_PI_CLI:fake,PI_WEBAPP_RUNTIME:'desktop',PI_WEBAPP_AUTO_OPEN:'0'},stdio:['ignore','ignore','ignore']});
  const exited=new Promise<number|null>(resolve=>supervisor.on('exit',resolve));let owner:any;
  try {
    for(let i=0;i<100;i++){try{owner=JSON.parse(await readFile(join(agentDir,'pi-web/launcher.json'),'utf8'));if(owner.url)break;}catch{}await delay(30);}
    assert.ok(owner?.url);assert.equal(owner.launcherHandoffProtocol,1);
    await writeHandoff(agentDir,{protocol:1,nonce:owner.nonce,pid:owner.pid,requestId:'0a71b412-1271-43c4-a013-4f100bb1bce1',phase:'requested'});
    await delay(5200);assert.equal(supervisor.exitCode,null);assert.equal((await readHandoff(agentDir))?.phase,'draining');
    assert.equal(await exited,0);assert.equal((await readHandoff(agentDir))?.phase,'stopped');
    await assert.rejects(readFile(marker),{code:'ENOENT'});
    await assert.rejects(readFile(join(agentDir,'pi-web/launcher.json')),{code:'ENOENT'});
  } finally {if(supervisor.exitCode===null)await exited;await rm(agentDir,{recursive:true,force:true});}
});
