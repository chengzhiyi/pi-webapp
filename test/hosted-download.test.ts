import test from "node:test";
import assert from "node:assert/strict";
import { drawingDownload } from "../src/host/client/hosted/download.ts";

test("drawing relay accepts only bounded local drawing blobs and safe filenames", () => {
  for (const [name, type] of [["中文.png", "image/png"], ["diagram.svg", "image/svg+xml"], ["draft.excalidraw", "application/json"]]) {
    const blob = new Blob(["fixture"], { type });
    assert.deepEqual(drawingDownload({ name, blob }), { name, blob });
  }
  for (const input of [
    {name:"../drawing.png",blob:new Blob(["x"],{type:"image/png"})},
    {name:"drawing.exe",blob:new Blob(["x"],{type:"image/png"})},
    {name:"drawing.png",blob:new Blob(["x"],{type:"text/html"})},
    {name:"drawing.svg",blob:new Blob([],{type:"image/svg+xml"})},
    {name:"drawing.png",url:"https://example.com/image.png"},
    {name:"drawing.png",blob:new Blob([new Uint8Array(16*1024*1024+1)],{type:"image/png"})},
    {name:"drawing\n.png",blob:new Blob(["x"],{type:"image/png"})},
  ]) assert.throws(()=>drawingDownload(input));
});
