// Offline consumer inspection, after npm install --offline --ignore-scripts <host.tgz>.
// This is not a registry/protocol release check; do not bypass the dev-snapshot release guard.
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {resolve,join,relative,basename} from 'node:path';
const consumer=resolve(process.argv[2]??'.'), root=join(consumer,'node_modules/pi-webapp');
const lock=JSON.parse(await readFile(join(consumer,'package-lock.json'),'utf8'));
const forbidden=/(?:^|\/)node_modules\/(?:@excalidraw\/[^/]+|@mermaid-js\/[^/]+|mermaid|roughjs|perfect-freehand|@excalidraw)\/?$/;
assert.deepEqual(Object.keys(lock.packages).filter(name=>forbidden.test(name)),[],'Consumer dependency closure contains drawing editor dependencies');
const manifest=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
assert.ok(!manifest.dependencies['@excalidraw/excalidraw']);
let assets=0,bytes=0,mathFonts=0;
async function scan(folder){for(const entry of await readdir(folder,{withFileTypes:true})){
 const path=join(folder,entry.name);assert.ok(!entry.isSymbolicLink(),'No linked published assets');
 if(entry.isDirectory()){await scan(path);continue;}
 const file=relative(root,path),buffer=await readFile(path);assets++;bytes+=buffer.length;
 assert.doesNotMatch(file,/excalidraw\/fonts|diagrams-NOTICES|mermaid-to-excalidraw/i);
 if(/\.woff2?$/.test(file)){assert.match(basename(file),/^KaTeX_/,'Dedicated drawing fonts remain');mathFonts++;}
 if(/\.(?:js|css|html|json)$/.test(file))assert.doesNotMatch(buffer.toString(),/@excalidraw\/excalidraw|@excalidraw\/mermaid-to-excalidraw|Excalifont|Virgil-Regular|Xiaolai-Regular|convertToExcalidrawElements|mermaidAPI|ASSETS_FALLBACK_URL/,'Dedicated drawing code remains in '+file);
}}
await scan(join(root,'web/dist'));await scan(join(root,'dist'));
console.log(JSON.stringify({consumer,hostVersion:manifest.version,installedPackages:Object.keys(lock.packages).length-1,assets,assetBytes:bytes,mathFontFiles:mathFonts,drawingDependencies:0,drawingCodeAndFonts:0},null,2));
