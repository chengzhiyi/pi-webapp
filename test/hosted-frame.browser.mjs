import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
// Optional sibling artifact is read-only; no build/install/publish is performed here.
const dist = resolve(process.env.HOSTED_PLUGIN_DIST ?? "../pi-extensions-excalidraw/packages/excalidraw/dist");
const bundle = await build({ stdin: { contents: 'import {FrameAdapter, FrameRegistry} from "./src/host/client/hosted/frame-adapter.ts"; window.FrameAdapter=FrameAdapter; window.FrameRegistry=FrameRegistry;', resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", platform: "browser" });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage(); const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.hostname === "host.test") return route.fulfill({ contentType: "text/html", body: "<html><body><iframe style='width:1000px;height:750px'></iframe></body></html>" });
    if (url.hostname !== "plugin.test") throw new Error(`Unexpected network ${url.href}`);
    const path = resolve(dist, url.pathname.slice(1));
    assert.ok(path.startsWith(dist + "/"));
    await route.fulfill({ body: await readFile(path), contentType: ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" })[extname(path)] ?? "application/octet-stream" });
  });
  await page.goto("http://host.test"); await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate(async () => {
    window.draft = { id: "drawing", title: "中文", revision: 0, path: null, diskHash: null, savedRevision: null, candidate: null, scene: { type: "excalidraw", version: 2, source: "pi-webapp", elements: [], appState: { viewBackgroundColor: "#ffffff" }, files: {} } };
    window.adapter = new window.FrameAdapter(document.querySelector("iframe"), { pluginId: "excalidraw", generation: 7, mountId: "native-editor", sessionId: "session" }, async (method, input) => {
      if (method === "action") {
        if (input.action === "sync") { window.draft.scene = input.input.scene; window.draft.revision++; }
        if (["get", "sync"].includes(input.action)) return window.draft;
      }
      return null;
    }, 5000);
    await window.adapter.connect("http://plugin.test/frame.html", { kind: "editor", sessionId: "session", contentId: "drawing", locale: "zh", theme: "dark", visible: true });
  });
  const frame = page.frames().find(frame => frame.url().startsWith("http://plugin.test/"));
  assert.equal(new URL(frame.url()).searchParams.get("generation"), "7");
  await frame.locator(".excalidraw").waitFor();
  await frame.locator("label").filter({ has: frame.locator('[data-testid="toolbar-rectangle"]') }).click();
  const box = await frame.locator(".excalidraw").boundingBox();
  await page.mouse.move(box.x + 300, box.y + 300); await page.mouse.down(); await page.mouse.move(box.x + 500, box.y + 420); await page.mouse.up();
  await page.evaluate(() => window.adapter.call("flush"));
  assert.ok(await page.evaluate(() => window.draft.scene.elements.some(element => element.type === "rectangle")));
  await frame.evaluate(() => window.dispatchEvent(new CompositionEvent("compositionstart")));
  assert.match(await page.evaluate(() => window.adapter.call("flush").then(() => "unexpected", error => error.message)), /compos|drag/i);
  await frame.evaluate(() => window.dispatchEvent(new CompositionEvent("compositionend")));
  const snapshot = await page.evaluate(() => window.adapter.call("freeze"));
  assert.equal(snapshot.undoClearedOnReopen, true);
  await page.evaluate(snapshot => window.adapter.call("restore", snapshot), snapshot);
  assert.match(await page.evaluate(() => window.adapter.call("update", { sessionId: "other" }).then(() => "unexpected", error => error.message)), /Session cannot change/);
  await page.evaluate(() => window.adapter.call("dispose"));
  await page.evaluate(() => window.adapter.dispose());
  assert.deepEqual(errors, []);
  console.log("Host FrameAdapter -> real cross-origin Excalidraw: handshake, native draw, busy flush, freeze/restore, session fence, dispose passed");
} finally { await browser.close(); }
