import { test, expect } from "@playwright/test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBridge } from "../../src/host/server/transport/bridge.ts";
import { NodeTelemetry } from "../../src/platform/telemetry/telemetry.ts";
import { terminalHost } from "../helpers/terminal-host.ts";
import { publishDrawing, nativeMenu } from "../helpers/diagram-browser.ts";
import { DIAGRAM_PLUGIN, type DiagramDraft } from "../../src/plugins/builtin/diagrams/contract/diagrams.ts";
import { diagramReference } from "../../src/plugins/builtin/diagrams/contract/reference.ts";

for (const width of [1440, 390]) test(`agent tool → directly editable drawing → pure native canvas → hand edit → chat review → file/export at ${width}px`, async ({ page }, info) => {
  test.setTimeout(90_000); page.setDefaultTimeout(12000);
  const cwd = await mkdtemp(join(tmpdir(), "pi-diagram-browser-")), { host } = terminalHost(cwd);
  const bridge = await startBridge(host, new URL("../../web/dist/", import.meta.url).pathname, new NodeTelemetry({ env: { PI_WEB_SENTRY_ENABLED: "false" }, monitor: false }), { pluginSettingsFile: join(cwd, "plugins.json") });
  const url = new URL(bridge.url), headers = { Authorization: `Bearer ${url.hash.slice(1)}`, "Content-Type": "application/json" };
  const action = async <T,>(name: string, input: object): Promise<T> => {
    const response = await fetch(url.origin + `/api/diagrams/${name}`, { method: "POST", headers, body: JSON.stringify({ sessionId: "terminal-a", ...input }) });
    expect(response.status).toBe(200); return response.json();
  };
  const get = (id: string) => action<DiagramDraft>("get", { id });
  const errors: string[] = [], external: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("request", r => { if (/^https?:/.test(r.url()) && !r.url().startsWith(url.origin)) external.push(r.url()); });
  await page.setViewportSize({ width, height: 1000 }); await page.addInitScript(() => localStorage.setItem("pi-web-locale", "en"));
  try {
    const created = await bridge.runPluginTool(DIAGRAM_PLUGIN, cwd, "terminal-a", "view", diagramReference.elementsExample) as { id: string };
    publishDrawing(host, bridge, created, "登录流程", "excalidraw_create_view", diagramReference.elementsExample);
    await page.goto(bridge.url);
    const artifact = page.getByRole("article", { name: "Diagram: 登录流程", exact: true });
    await expect(artifact.getByRole("img")).toBeVisible();
    await expect.poll(async () => (await get(created.id)).scene.elements.length).toBeGreaterThan(3);
    await expect(artifact.getByRole("button", { name: "Apply edits", exact: true })).toHaveCount(0);
    await expect(page.locator(".excalidraw canvas")).toHaveCount(0);
    // The view is attached to the tool result, above the final answer, not a turn.tail card.
    expect(await artifact.evaluate(e => !!(e.closest('[data-tool-view="excalidraw_create_view"]')))).toBe(true);
    await artifact.getByRole("button", { name: "Edit Excalidraw", exact: true }).click();
    const panel = page.locator("[data-sidebar-right-session]");
    await expect(panel.locator(".excalidraw canvas.interactive")).toBeVisible();
    await expect(panel.getByRole("textbox")).toHaveCount(0);
    await expect(panel.getByText(/Turn ideas into diagrams|Describe your idea|Ask agent to draw|Accept candidate|Files & more/)).toHaveCount(0);
    await expect(panel.locator("textarea")).toHaveCount(0);
    const before = await get(created.id), position = before.scene.elements.find(e => e.id === "input")!.x;
    const native = panel.locator(".excalidraw canvas.interactive"); await native.click();
    await page.keyboard.press("ControlOrMeta+a"); await page.keyboard.press("ArrowRight"); await page.keyboard.press("Escape");
    await expect.poll(async () => (await get(created.id)).scene.elements.find(e => e.id === "input")?.x).not.toBe(position);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(async () => (await get(created.id)).scene.elements.find(e => e.id === "input")?.x).toBe(position);
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect.poll(async () => (await get(created.id)).scene.elements.find(e => e.id === "input")?.x).not.toBe(position);
    let draft = await get(created.id); const handX = draft.scene.elements.find(e => e.id === "input")!.x;
    const active = await bridge.runPluginTool(DIAGRAM_PLUGIN, cwd, "terminal-a", "read", {}) as { id: string; revision: number };
    expect(active.id).toBe(created.id); expect(active.revision).toBe(draft.revision);
    const patch = { addNodes: [{ id: "success", label: "登录成功", x: 750, y: 80 }], addEdges: [{ id: "pass", from: "check", to: "success", label: "通过" }] };
    await bridge.runPluginTool(DIAGRAM_PLUGIN, cwd, "terminal-a", "patch", { id: draft.id, baseRevision: draft.revision, patch });
    // Review is exclusively in the chat result; native panel remains directly editable.
    await expect(artifact.getByRole("button", { name: "Keep original", exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Apply edits", exact: true })).toHaveCount(0);
    // On narrow screens the fullscreen panel overlays chat; use the regular host control.
    if (width === 390) await panel.getByRole("button", { name: "Collapse right sidebar", exact: true }).click();
    await artifact.getByRole("button", { name: "Keep original", exact: true }).click();
    expect((await get(created.id)).scene.elements.some(e => e.id === "success")).toBe(false);
    draft = await get(created.id);
    await bridge.runPluginTool(DIAGRAM_PLUGIN, cwd, "terminal-a", "patch", { id: draft.id, baseRevision: draft.revision, patch });
    await expect(artifact.getByRole("button", { name: "Apply edits", exact: true })).toBeEnabled();
    await artifact.getByRole("button", { name: "Apply edits", exact: true }).click();
    await expect.poll(async () => (await get(created.id)).scene.elements.some(e => e.id === "success")).toBe(true);
    expect((await get(created.id)).scene.elements.find(e => e.id === "input")!.x).toBe(handX);
    await artifact.getByRole("button", { name: "Edit Excalidraw", exact: true }).click();
    await nativeMenu(page, "Save / Save as to workspace");
    const dialog = page.getByRole("dialog", { name: "Save diagram", exact: true });
    await dialog.getByRole("textbox", { name: "Workspace path", exact: true }).fill("diagrams/login.excalidraw");
    await dialog.getByRole("button", { name: "Save", exact: true }).click(); await expect(dialog).toHaveCount(0);
    const saved = JSON.parse(await readFile(join(cwd, "diagrams/login.excalidraw"), "utf8")); expect(saved.elements.some((e: { id: string }) => e.id === "success")).toBe(true);
    for (const name of ["Export PNG", "Export transparent PNG", "Download source"]) {
      const download = page.waitForEvent("download"); await nativeMenu(page, name); const file = await download;
      await file.saveAs(info.outputPath(`${name === "Download source" ? "source.excalidraw" : name === "Export PNG" ? "export.png" : "transparent.png"}`));
      const bytes = await readFile((await file.path())!);
      if (name === "Download source") expect(JSON.parse(bytes.toString()).elements).toEqual(saved.elements);
      else { expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]); expect(bytes.length).toBeGreaterThan(10000);
        if (name === "Export transparent PNG") expect(await page.evaluate(async bytes => { const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: "image/png" })); const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height; const ctx = canvas.getContext("2d")!; ctx.drawImage(bitmap, 0, 0); return ctx.getImageData(0, 0, 1, 1).data[3]; }, [...bytes])).toBe(0);
      }
    }
    await page.screenshot({ path: info.outputPath(`pure-editor-${width}.png`) });
    await writeFile(join(cwd, "diagrams/login.excalidraw"), JSON.stringify({ ...saved, source: "external-writer" }));
    await nativeMenu(page, "Save / Save as to workspace"); await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("外部修改");
    expect(JSON.parse(await readFile(join(cwd, "diagrams/login.excalidraw"), "utf8")).source).toBe("external-writer");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.reload();
    await page.getByRole("button", { name: "Edit Excalidraw", exact: true }).click();
    await nativeMenu(page, "Open workspace diagram");
    const open = page.getByRole("dialog", { name: "Open diagram", exact: true }); await open.getByRole("textbox", { name: "Workspace path", exact: true }).fill("diagrams/login.excalidraw"); await open.getByRole("button", { name: "Open", exact: true }).click();
    await expect(panel.locator(".excalidraw canvas.interactive")).toBeVisible();
    expect(errors).toEqual([]); expect(external).toEqual([]);
  } finally { await page.close(); await bridge.close(); await rm(cwd, { recursive: true, force: true }); }
});
