import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";

test("historical aliases/tools offer honest install/enable recovery without editor code or stale argument reconstruction",async()=>{
  const result=await build({stdin:{contents:`import {drawingRecovery} from './src/host/client/legacy-diagrams.tsx'; import {renderToStaticMarkup} from 'react-dom/server'; import {createElement} from 'react'; export function probe(){ const plugin=drawingRecovery(()=>{}); const work=plugin.definition.workbench; return { alias:work.resolvePanel('diagram:historical'), invalid:work.resolvePanel('diagram:../bad'), tools:work.toolViews[0].tools, html:renderToStaticMarkup(createElement(work.toolViews[0].component,{locale:'en',call:{arguments:{elements:'stale model geometry'}}}))}; }`,resolveDir:process.cwd(),loader:"tsx"},bundle:true,jsx:"automatic",platform:"node",format:"cjs",write:false,logLevel:"silent"});
  const module={exports:{} as any};new Function("require","module","exports",result.outputFiles[0]!.text)(createRequire(import.meta.url),module,module.exports);
  const value=module.exports.probe();
  assert.deepEqual(value.alias,{kind:"drawing-recovery",contentId:"historical",title:"Excalidraw"});assert.equal(value.invalid,null);
  assert.deepEqual(value.tools,["excalidraw_create_view","diagram_create","diagram_patch"]);
  assert.match(value.html,/editor is currently unavailable/);assert.match(value.html,/runtime diagnostics/);assert.match(value.html,/Open plugin management/);assert.doesNotMatch(value.html,/stale model geometry|<canvas|<iframe/);
  assert.doesNotMatch(result.outputFiles[0]!.text,/@excalidraw\/excalidraw|ExcalidrawAutomate|mermaidAPI|Excalifont/);
});
