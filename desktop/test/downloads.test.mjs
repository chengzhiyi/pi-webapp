import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { configureLocalExport } from "../downloads.mjs";

function fixture(overrides = {}) {
  const backendUrl = "http://127.0.0.1:4567/#" + "a".repeat(32);
  const blob = "blob:http://127.0.0.1:4567/12345678-1234-1234-1234-123456789abc";
  let prevented = false, options;
  const event = { preventDefault() { prevented = true; } };
  const contents = { isDestroyed: () => false, getURL: () => backendUrl };
  const item = { getURL: () => blob, getURLChain: () => [blob], getFilename: () => "中文.png", getMimeType: () => "image/png", setSaveDialogOptions(value) { options = value; }, ...overrides };
  const input = { expectedContents: contents, backendUrl, downloadsPath: "/isolated-downloads" };
  return { event, item, contents, input, get prevented() { return prevented; }, get options() { return options; } };
}
test("current trusted local PNG/SVG/source exports retain native destination and overwrite consent", () => {
  for (const [extension, mime] of [["png", "image/png"], ["svg", "image/svg+xml"], ["excalidraw", "application/json"], ["json", "application/json"]]) {
    const f = fixture({ getFilename: () => `中文.${extension}`, getMimeType: () => mime });
    assert.equal(configureLocalExport(f.event, f.item, f.contents, f.input), true);
    assert.equal(f.prevented, false); assert.equal(f.options.defaultPath, join("/isolated-downloads", `中文.${extension}`));
    assert.ok(f.options.properties.includes("showOverwriteConfirmation"));
    assert.deepEqual(f.options.filters[0].extensions, [extension]);
  }
});
test("remote, redirected, foreign-document, executable and ambiguous local downloads stay denied", () => {
  const denied = [
    { getURL: () => "https://example.invalid/diagram.png" },
    { getURL: () => "file:///tmp/a.png" },
    { getURL: () => "data:image/png;base64,eA==" },
    { getURLChain: () => ["https://example.invalid/diagram.png"] },
    { getURL: () => "blob:http://127.0.0.1:4568/12345678-1234-1234-1234-123456789abc" },
    { getFilename: () => "../diagram.png" }, { getFilename: () => "..\\diagram.png" },
    { getFilename: () => "bad\u0000.png" }, { getFilename: () => "a.exe" },
    { getFilename: () => "a.png.exe" }, { getMimeType: () => "text/html" },
    { getURL: () => "blob:null/12345678-1234-1234-1234-123456789abc" },
  ];
  for (const overrides of denied) {
    const f = fixture(overrides); assert.equal(configureLocalExport(f.event, f.item, f.contents, f.input), false); assert.equal(f.prevented, true); assert.equal(f.options, undefined);
  }
  for (const changes of [{ backendUrl: undefined }, { expectedContents: {} }]) {
    const f = fixture(); assert.equal(configureLocalExport(f.event, f.item, f.contents, { ...f.input, ...changes }), false); assert.equal(f.prevented, true);
  }
  for (const contents of [{ isDestroyed: () => true }, { isDestroyed: () => false, getURL: () => "https://example.invalid/" }]) {
    const f = fixture(); assert.equal(configureLocalExport(f.event, f.item, contents, { ...f.input, expectedContents: contents }), false); assert.equal(f.prevented, true);
  }
});
