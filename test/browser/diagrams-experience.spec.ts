import { test, expect } from "@playwright/test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBridge } from "../../src/host/server/transport/bridge.ts";
import { NodeTelemetry } from "../../src/platform/telemetry/telemetry.ts";
import { terminalHost } from "../helpers/terminal-host.ts";
import { publishDrawing, nativeMenu } from "../helpers/diagram-browser.ts";
import { DIAGRAM_PLUGIN, type DiagramDraft } from "../../src/plugins/builtin/diagrams/contract/diagrams.ts";
import { architectureExample } from "../../src/plugins/builtin/diagrams/contract/reference.ts";

for (const width of [1440, 390]) test(`reference architecture: direct creation, pure editor, chat review and stale protection at ${width}px`, async ({ page }, info) => {
  test.setTimeout(60_000); page.setDefaultTimeout(12000);
  const cwd = await mkdtemp(join(tmpdir(), "pi-diagram-experience-")), { host } = terminalHost(cwd);
  const bridge = await startBridge(host, new URL("../../web/dist/", import.meta.url).pathname, new NodeTelemetry({ env: { PI_WEB_SENTRY_ENABLED: "false" }, monitor: false }), { pluginSettingsFile: join(cwd, "plugins.json") });
  const url = new URL(bridge.url), headers = { Authorization: `Bearer ${url.hash.slice(1)}`, "Content-Type": "application/json" };
  const get = async (id: string): Promise<DiagramDraft> => fetch(url.origin + "/api/diagrams/get", { method: "POST", headers, body: JSON.stringify({ sessionId: "terminal-a", id }) }).then(r => r.json());
  const errors: string[] = [], external: string[] = [];
  page.on("pageerror", e => errors.push(e.message)); page.on("request", r => { if (/^https?:/.test(r.url()) && !r.url().startsWith(url.origin)) external.push(r.url()); });
  await page.setViewportSize({ width, height: 1050 }); await page.addInitScript(() => { localStorage.setItem("pi-web-locale", "en"); Reflect.deleteProperty(window, "showSaveFilePicker"); Reflect.deleteProperty(window, "showOpenFilePicker"); });
  try {
    const created = await bridge.runPluginTool(DIAGRAM_PLUGIN, cwd, "terminal-a", "create", { title: "Pi 分层架构", graph: architectureExample }) as { id: string };
    publishDrawing(host, bridge, created, "Pi 分层架构", "diagram_create", { title: "Pi 分层架构", graph: architectureExample });
    await page.goto(bridge.url);
    const artifact = page.getByRole("article", { name: "Diagram: Pi 分层架构", exact: true }), image = artifact.getByRole("img", { name: "Pi 分层架构", exact: true });
    await expect(image).toBeVisible(); await expect.poll(async () => (await get(created.id)).candidate).toBe(null);
    await expect(page.locator(".excalidraw canvas")).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`inline-${width}.png`) });
    await artifact.getByRole("button", { name: "Edit Excalidraw", exact: true }).click();
    const panel = page.locator("[data-sidebar-right-session]"); await expect(panel.locator(".excalidraw canvas.interactive")).toBeVisible();
    await expect(panel.getByRole("textbox")).toHaveCount(0);
    let draft = await get(created.id);
    for (const n of architectureExample.nodes) {
      const element = draft.scene.elements.find(e => e.id === n.id)!; expect(element).toBeTruthy(); expect(draft.scene.elements.some(e => e.text === n.label)).toBe(true);
      if (n.kind === "group") { expect(element.backgroundColor).toBe(n.backgroundColor); expect(draft.scene.elements.find(e => e.containerId === n.id)?.verticalAlign).toBe("top"); }
    }
    expect(draft.scene.elements.find(e => e.id === "title")?.fontSize).toBe(36);
    expect(draft.scene.elements.find(e => e.id === "experiment")?.strokeStyle).toBe("dashed");
    expect(draft.scene.elements.find(e => e.id === "cli")?.groupIds).toEqual(["group-entry"]);
    const untouched = structuredClone(draft.scene.elements.find(e => e.id === "manager"));
    const previousPreview = await image.getAttribute("src");
    await bridge.runPluginTool(DIAGRAM_PLUGIN, cwd, "terminal-a", "patch", { id: draft.id, baseRevision: draft.revision, patch: { updateElements: [{ id: "title", label: "Pi 架构 · 已优化", fontSize: 32 }, { id: "cli", x: 140, width: 340, backgroundColor: "#dbeafe" }] } });
    if (width === 390) await panel.getByRole("button", { name: "Collapse right sidebar", exact: true }).click();
    await expect(artifact.getByRole("button", { name: "Apply edits", exact: true })).toBeEnabled(); await artifact.getByRole("button", { name: "Apply edits", exact: true }).click();
    await expect.poll(async () => (await get(created.id)).scene.elements.find(e => e.id === "title")?.text).toBe("Pi 架构 · 已优化");
    draft = await get(created.id); expect(draft.scene.elements.find(e => e.id === "manager")).toEqual(untouched);
    expect(draft.scene.elements.find(e => e.id === "cli")?.x).toBe(140);
    await expect(image).toHaveAttribute("data-scene-revision", `${draft.revision}:current`); await expect.poll(() => image.getAttribute("src")).not.toBe(previousPreview);
    await artifact.getByRole("button", { name: "Edit Excalidraw", exact: true }).click();
    const box = await panel.locator("[data-diagram-canvas]").boundingBox(); expect(box!.height).toBeGreaterThan(700);
    await page.screenshot({ path: info.outputPath(`editor-${width}.png`) });
    const download = page.waitForEvent("download"); await nativeMenu(page, "Export PNG"); const png = await download;
    await png.saveAs(info.outputPath(`architecture-${width}.png`)); expect((await readFile((await png.path())!)).length).toBeGreaterThan(20000);
    // A candidate produced before a hand edit cannot overwrite it, even though the panel has no review form.
    draft = await get(created.id);
    await bridge.runPluginTool(DIAGRAM_PLUGIN, cwd, "terminal-a", "patch", { id: draft.id, baseRevision: draft.revision, patch: { updateElements: [{ id: "cli", x: 999 }] } });
    await panel.locator(".excalidraw canvas.interactive").click(); await page.keyboard.press("ControlOrMeta+a"); await page.keyboard.press("ArrowRight"); await page.keyboard.press("Escape");
    await expect.poll(async () => (await get(created.id)).revision).toBeGreaterThan(draft.revision);
    if (width === 390) await panel.getByRole("button", { name: "Collapse right sidebar", exact: true }).click();
    await expect(artifact.getByRole("button", { name: "Apply edits", exact: true })).toBeDisabled(); expect((await get(created.id)).scene.elements.find(e => e.id === "cli")?.x).not.toBe(999);
    await artifact.getByRole("button", { name: "Keep original", exact: true }).click();
    expect(errors).toEqual([]); expect(external).toEqual([]);
  } finally { await page.close(); await bridge.close(); await rm(cwd, { recursive: true, force: true }); }
});

for (const width of [1440, 390]) test(`manual canvas starts at 100%, shares its plugin icon; native Open, retained backups and disablement at ${width}px`, async ({ page }, info) => {
  test.setTimeout(45_000);
  await page.setViewportSize({ width, height: 1000 });
  const cwd = await mkdtemp(join(tmpdir(), "pi-diagram-native-entry-")), { host } = terminalHost(cwd);
  const bridge = await startBridge(host, new URL("../../web/dist/", import.meta.url).pathname, new NodeTelemetry({ env: { PI_WEB_SENTRY_ENABLED: "false" }, monitor: false }), { pluginSettingsFile: join(cwd, "plugins.json") });
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  const url = new URL(bridge.url), headers = { Authorization: `Bearer ${url.hash.slice(1)}`, "Content-Type": "application/json" };
  await page.addInitScript(() => { localStorage.setItem("pi-web-locale", "en"); Reflect.deleteProperty(window, "showSaveFilePicker"); Reflect.deleteProperty(window, "showOpenFilePicker"); });
  try {
    await page.goto(bridge.url); await expect(page.locator(".excalidraw")).toHaveCount(0);
    await page.getByRole("button", { name: "Open right sidebar", exact: true }).click();
    const panel = page.locator("[data-sidebar-right-session]");
    const entry = panel.getByRole("button", { name: "Excalidraw", exact: true });
    const artwork = await entry.locator('[aria-hidden="true"]').first().textContent();
    expect(artwork).toBe("✎");
    await entry.click();
    await expect(panel.locator(".excalidraw canvas.interactive")).toBeVisible(); await expect(panel.getByRole("textbox")).toHaveCount(0);
    const current = async () => bridge.runPluginTool(DIAGRAM_PLUGIN, cwd, "terminal-a", "read", {}) as Promise<{ elements: { id: string; width: number }[] }>;
    // Native compact UI hides zoom controls. Verify actual scene/screen scale instead:
    // a 120px pointer drag must create a 120-unit rectangle at 100% on both sizes.
    const draw = async (dy = 0) => {
      const ids = new Set((await current()).elements.map(e => e.id));
      await panel.getByRole("radio", { name: "Rectangle", exact: true }).locator("..").click();
      const box = (await panel.locator("canvas.interactive").boundingBox())!;
      await page.mouse.move(box.x + box.width / 2 - 60, box.y + box.height / 2 + dy);
      await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + dy + 70); await page.mouse.up();
      await expect.poll(async () => (await current()).elements.filter(e => !ids.has(e.id)).length).toBe(1);
      return (await current()).elements.find(e => !ids.has(e.id))!;
    };
    expect((await draw()).width).toBeCloseTo(120, 0);
    if (width === 1440) {
      await panel.getByRole("button", { name: "Fullscreen", exact: true }).click();
      await expect(panel.locator(".reset-zoom-button")).toHaveText("100%");
    }
    await page.screenshot({ path: info.outputPath(`manual-zoom-${width}.png`) });
    if (width === 1440) await panel.getByRole("button", { name: "Exit fullscreen", exact: true }).click();
    // Native user zoom survives hand edits and the next server refresh.
    // Restore canvas focus after using the host fullscreen control.
    await panel.locator("canvas.interactive").click({ position: { x: 300, y: 300 } });
    await page.keyboard.press("ControlOrMeta+-");
    const resized = await draw(120); expect(resized.width).toBeGreaterThan(120);
    expect((await draw(-120)).width).toBeCloseTo(resized.width, 0);
    const list = async (): Promise<DiagramDraft[]> => fetch(url.origin + "/api/diagrams/list", { method: "POST", headers, body: JSON.stringify({ sessionId: "terminal-a" }) }).then(r => r.json());
    // diagram_read intentionally summarizes fields for the model; source files need the full native scene.
    const nativeDraft: DiagramDraft = await fetch(url.origin + "/api/diagrams/get", { method: "POST", headers, body: JSON.stringify({ sessionId: "terminal-a", id: (await list())[0]!.id }) }).then(r => r.json());
    const nativeScene = nativeDraft.scene;
    const source = { ...nativeScene, elements: [{ ...nativeScene.elements[0], id: "manual", x: 10, y: 20, width: 200, height: 100 }] };
    const chooser = page.waitForEvent("filechooser"); await nativeMenu(page, "Import source");
    await (await chooser).setFiles({ name: "manual.excalidraw", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(source)) });
    await expect(panel.locator(".excalidraw canvas.interactive")).toBeVisible();
    await expect.poll(async () => (await current()).elements.some(e => e.id === "manual")).toBe(true);
    expect((await list()).length).toBe(1); // Official Open keeps the active identity.
    await expect(panel.getByRole("alert")).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`native-open-${width}.png`) });
    expect((await draw()).width).toBeCloseTo(120, 0); // Native Open resets this portable scene to 100%.
    // Removing the custom backup browser must not delete any retained backup data.
    await page.evaluate(source => localStorage.setItem("pi-diagram:terminal-a:expired-source", JSON.stringify(source)), source);
    await panel.getByTestId("main-menu-trigger").click();
    await expect(panel.getByText("Workspace & backups", { exact: true })).toHaveCount(0);
    await expect(panel.getByText("Recover local backup", { exact: true })).toHaveCount(0);
    await panel.getByTestId("main-menu-trigger").click();
    expect(await page.evaluate(() => !!localStorage.getItem("pi-diagram:terminal-a:expired-source"))).toBe(true);
    if (width === 390) await panel.getByRole("button", { name: "Collapse right sidebar", exact: true }).click();
    await page.getByRole("button", { name: "Plugins", exact: true }).click();
    const plugin = page.locator(`[data-plugin-package="${DIAGRAM_PLUGIN}"]`);
    await expect(plugin.locator(':scope > [aria-hidden="true"]')).toHaveText(artwork!);
    await page.screenshot({ path: info.outputPath(`plugin-icon-${width}.png`) });
    await plugin.getByRole("button", { name: "Diagrams", exact: true }).click();
    await expect(page.locator('[data-plugin-panel]').getByText(artwork!, { exact: true })).toBeVisible();
    const management = await fetch(url.origin + "/api/plugin-management", { headers }).then(r => r.json());
    const disabled = await fetch(url.origin + "/api/plugin-management", { method: "POST", headers, body: JSON.stringify({ sessionId: "terminal-a", id: DIAGRAM_PLUGIN, enabled: false, expected: management.revision }) });
    expect(disabled.status).toBe(200); await expect(panel.locator(".excalidraw canvas")).toHaveCount(0);
    await expect(bridge.runPluginTool(DIAGRAM_PLUGIN, cwd, "terminal-a", "read", {})).rejects.toThrow(/停用/);
    expect(errors).toEqual([]);
  } finally { await page.close(); await bridge.close(); await rm(cwd, { recursive: true, force: true }); }
});

test("tool arguments paint progressively before completion, with no invented progress or native editor mounted", async ({ page }, info) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-diagram-stream-")), { host } = terminalHost(cwd);
  const bridge = await startBridge(host, new URL("../../web/dist/", import.meta.url).pathname);
  await page.addInitScript(() => { localStorage.setItem("pi-web-locale", "en"); localStorage.setItem("pi-web-theme", "dark"); });
  try {
    const elements = architectureExample.nodes.slice(1, 3).map((n, i) => ({ type: "rectangle", id: `shape${i}`, groupIds: ["渐进层_2"], x: i * 350, y: 0, width: 300, height: 130, backgroundColor: n.backgroundColor, label: { text: n.label, fontSize: 20 } }));
    const session = host.snapshot(); session.idle = false;
    session.messages = [{ id: "u-stream", role: "user", timestamp: new Date().toISOString(), blocks: [{ kind: "text", text: "画出架构" }] }];
    const stream = (text: string) => ({ id: "stream", role: "assistant" as const, timestamp: new Date().toISOString(), blocks: [{ kind: "toolCall" as const, toolName: "excalidraw_create_view", toolCallId: "stream-call", text: JSON.stringify({ title: "渐进架构", elements: text }) }] });
    session.streaming = stream("[" + JSON.stringify(elements[0]) + ",{");
    await page.goto(bridge.url);
    const preview = page.locator("[data-stream-preview]"); await expect(preview).toBeVisible();
    const pixel = await preview.evaluate(async (img: HTMLImageElement) => { await img.decode(); const c = document.createElement("canvas"); c.width = c.height = 1; const ctx = c.getContext("2d")!; ctx.drawImage(img, 0, 0); return ctx.getImageData(0, 0, 1, 1).data[0]; });
    expect(pixel).toBeLessThan(100);
    const first = await preview.getAttribute("src");
    bridge.publish({ type: "stream", message: stream(JSON.stringify(elements)) });
    await expect.poll(() => preview.getAttribute("src")).not.toBe(first);
    await expect(page.locator(".excalidraw canvas")).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("stream-before-tool-result.png") });
    const created = await bridge.runPluginTool(DIAGRAM_PLUGIN, cwd, "terminal-a", "view", { title: "渐进架构", elements: JSON.stringify(elements) }) as { id: string };
    publishDrawing(host, bridge, created, "渐进架构");
    await expect(page.getByRole("article", { name: "Diagram: 渐进架构", exact: true }).getByRole("img")).toBeVisible();
    await expect(preview).toHaveCount(0);
  } finally { await page.close(); await bridge.close(); await rm(cwd, { recursive: true, force: true }); }
});
