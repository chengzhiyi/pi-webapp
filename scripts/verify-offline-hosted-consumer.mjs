// Actual installed extension + SDK/TUI command + HTTP + browser, no registry/provider access.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium} from '@playwright/test';
const consumer=resolve(process.argv[2]);
const {createAgentSession,DefaultResourceLoader,SessionManager}=await import(pathToFileURL(join(consumer,'node_modules/@earendil-works/pi-coding-agent/dist/index.js')));
const extension=await import(pathToFileURL(join(consumer,'node_modules/pi-webapp/dist/extension.js')));
const root=await mkdtemp(join(tmpdir(),'installed-host-offline-'));
process.env.PI_CODING_AGENT_DIR=join(root,'agent');process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS='';process.env.PI_WEBAPP_HOSTED_EXCALIDRAW='0';
let url='',network=0;const nativeFetch=globalThis.fetch;
globalThis.fetch=(target,...args)=>{const address=new URL(String(target));if(!['localhost','127.0.0.1','[::1]'].includes(address.hostname)){network++;throw new Error('Offline consumer denied external request');}return nativeFetch(target,...args);};
const loader=new DefaultResourceLoader({cwd:root,agentDir:join(root,'agent'),noExtensions:true,noSkills:true,noPromptTemplates:true,extensionFactories:[api=>extension.default(api,async address=>{url=address;return false;})]});
await loader.reload();const {session}=await createAgentSession({cwd:root,sessionManager:SessionManager.inMemory(root),resourceLoader:loader});
const errors=[];let browser;
try{
 await session.bindExtensions({mode:'print',onError:error=>errors.push(error.error)});
 assert.deepEqual(errors,[]);assert.ok(!session.getAllTools().some(tool=>/^(diagram_|excalidraw_)/.test(tool.name)));
 await session.prompt('/web');assert.ok(url,'Installed /web command starts actual bridge');
 const address=new URL(url),headers={Authorization:'Bearer '+address.hash.slice(1)};
 const response=await fetch(address.origin+'/api/hosted-plugins',{headers});assert.equal(response.status,200);
 const catalog=await response.json();assert.equal(catalog.plugins[0].installed,false);assert.equal(catalog.plugins[0].enabled,false);
 assert.equal((await fetch(address.origin+'/api/diagrams/new',{method:'POST',headers:{...headers,Origin:address.origin,'Content-Type':'application/json'},body:JSON.stringify({sessionId:session.sessionManager.getSessionId()})})).status,404);
 browser=await chromium.launch({headless:true});const page=await browser.newPage();const requests=[],pageErrors=[];
 page.on('request',request=>requests.push(request.url()));page.on('pageerror',error=>pageErrors.push(error.message));
 await page.addInitScript(()=>localStorage.setItem('pi-web-locale','en'));await page.goto(url);
 // A clean profile has no provider credentials; dismiss the honest model-setup dialog.
 await page.getByRole('button',{name:'Close Pi settings',exact:true}).click();
 await page.getByRole('button',{name:'Plugins',exact:true}).click();await page.locator('[data-hosted-management]').getByText('Not installed · Disabled',{exact:true}).waitFor();
 assert.deepEqual(requests.filter(value=>/^https?:/.test(value)&&new URL(value).origin!==address.origin),[]);
 assert.deepEqual(requests.filter(value=>/\/hosted-plugins\/|Excalifont|Virgil|Xiaolai|mermaid/i.test(value)),[]);
 assert.deepEqual(pageErrors,[]);assert.equal(network,0);
 console.log(JSON.stringify({actualInstalledExtension:true,retiredFlag:'0',officialCard:'absent',builtinDrawingTools:0,builtinDrawingAPI:404,pluginResourceRequests:0,externalRequests:network,pageErrors:0},null,2));
}finally{await browser?.close();await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'});session.dispose();globalThis.fetch=nativeFetch;await rm(root,{recursive:true,force:true});}
