import { test, expect } from "@playwright/test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBridge } from "../../src/host/server/transport/bridge.ts";
import { NodeTelemetry } from "../../src/platform/telemetry/telemetry.ts";
import { terminalHost } from "../helpers/terminal-host.ts";
import { publishDrawing, nativeMenu } from "../helpers/diagram-browser.ts";
import { DIAGRAM_PLUGIN, type DiagramDraft } from "../../src/plugins/builtin/diagrams/contract/diagrams.ts";

for (const width of [1440, 390]) test(`grouped agent drawing round-trips; native UI follows host theme at ${width}px`, async ({ page }, info) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width, height: 1000 });
  await page.emulateMedia({ colorScheme: "light" });
  await page.addInitScript(() => { localStorage.setItem("pi-web-locale", "en"); localStorage.setItem("pi-web-theme", "dark"); Reflect.deleteProperty(window, "showSaveFilePicker"); Reflect.deleteProperty(window, "showOpenFilePicker"); });
  const cwd = await mkdtemp(join(tmpdir(), "pi-diagram-groups-theme-")), { host } = terminalHost(cwd);
  const bridge = await startBridge(host, new URL("../../web/dist/", import.meta.url).pathname, new NodeTelemetry({ env: { PI_WEB_SENTRY_ENABLED: "false" }, monitor: false }));
  const url = new URL(bridge.url), headers = { Authorization: `Bearer ${url.hash.slice(1)}`, "Content-Type": "application/json" };
  const action = async (operation: string, input: object) => {
    const response = await fetch(url.origin + `/api/diagrams/${operation}`, { method: "POST", headers, body: JSON.stringify({ sessionId: "terminal-a", ...input }) });
    expect(response.ok).toBe(true); return response.json() as Promise<DiagramDraft>;
  };
  const errors: string[] = [], external: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", r => { if (/^https?:/.test(r.url()) && !r.url().startsWith(url.origin)) external.push(r.url()); });
  try {
    const elements = [
      { type: "rectangle", id: "entry", x: 0, y: 0, width: 200, height: 100, groupIds: ["入口层_2", "architecture-123"], label: { text: "入口", fontSize: 20 } },
      { type: "rectangle", id: "core", x: 300, y: 0, width: 200, height: 100, groupIds: ["core-layer_3", "architecture-123"], label: { text: "核心", fontSize: 20 } },
    ];
    const input = { title: "分组架构", elements: JSON.stringify(elements) };
    const created = await bridge.runPluginTool(DIAGRAM_PLUGIN, cwd, "terminal-a", "view", input) as { id: string };
    publishDrawing(host, bridge, created, input.title, "excalidraw_create_view", input);
    const get = () => action("get", { id: created.id });
    await page.goto(bridge.url);
    const artifact = page.getByRole("article", { name: "Diagram: 分组架构", exact: true });
    await expect(artifact.getByRole("img")).toBeVisible();
    expect(await artifact.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe("rgb(255, 255, 255)");
    const previewPixel = () => artifact.getByRole("img").evaluate(async (img: HTMLImageElement) => {
      await img.decode(); const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
      const ctx = canvas.getContext("2d")!; ctx.drawImage(img, 0, 0); return [...ctx.getImageData(0, 0, 1, 1).data];
    });
    await expect.poll(async () => (await previewPixel())[0]!).toBeLessThan(100);
    await expect.poll(async () => (await get()).candidate).toBe(null);
    await artifact.getByRole("button", { name: "Edit Excalidraw", exact: true }).click();
    const panel = page.locator("[data-sidebar-right-session]"), editor = panel.locator(".excalidraw");
    await expect(editor.locator("canvas.interactive")).toBeVisible();
    await expect(editor).toHaveClass(/theme--dark/);
    for (const element of elements) expect((await get()).scene.elements.find(e => e.id === element.id)?.groupIds).toEqual(element.groupIds);
    await expect(editor.locator(".help-icon")).toBeHidden();
    await editor.locator(".App-toolbar__extra-tools-trigger").click();
    await expect(editor.getByText("Generate", { exact: true })).toBeHidden();
    await expect(editor.getByTestId("toolbar-frame")).toBeVisible();
    await expect(editor.getByTestId("toolbar-laser")).toBeVisible();
    await page.screenshot({ path: info.outputPath(`groups-dark-extra-tools-${width}.png`) });
    await editor.locator(".App-toolbar__extra-tools-trigger").click();
    await editor.getByTestId("main-menu-trigger").click();
    await expect(editor.getByText(/^(Light|Dark) mode$/)).toHaveCount(0);
    await expect(editor.getByText("Canvas background", { exact: true })).toBeVisible();
    await editor.getByTestId("main-menu-trigger").click();
    await expect(editor.getByText("Canvas background", { exact: true })).toHaveCount(0);
    await nativeMenu(page, "Save / Save as to workspace");
    const darkDialog = page.getByRole("dialog", { name: "Save diagram", exact: true });
    expect(await darkDialog.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe("rgb(255, 255, 255)");
    expect(await darkDialog.getByRole("textbox").evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe("rgb(255, 255, 255)");
    await darkDialog.getByRole("button", { name: "Cancel", exact: true }).click();
    const beforeTheme = (await get()).scene;
    // Exercise the host's real cross-tab storage handler, then system preference updates.
    const preference = async (theme: string) => page.evaluate(theme => {
      localStorage.setItem("pi-web-theme", theme);
      window.dispatchEvent(new StorageEvent("storage", { key: "pi-web-theme", newValue: theme }));
    }, theme);
    await preference("light"); await expect(editor).not.toHaveClass(/theme--dark/);
    await expect.poll(async () => (await previewPixel())[0]!).toBeGreaterThan(200);
    expect(await artifact.evaluate(el => getComputedStyle(el).backgroundColor)).toBe("rgb(255, 255, 255)");
    await preference("dark"); await expect(editor).toHaveClass(/theme--dark/);
    await preference("system"); await expect(editor).not.toHaveClass(/theme--dark/);
    await page.emulateMedia({ colorScheme: "dark" }); await expect(editor).toHaveClass(/theme--dark/);
    await page.emulateMedia({ colorScheme: "light" }); await expect(editor).not.toHaveClass(/theme--dark/);
    expect((await get()).scene).toEqual(beforeTheme);
    // A native edit must synchronize grouped elements instead of blocking the next chat.
    const before = await get();
    await editor.locator("canvas.interactive").click();
    await page.keyboard.press("ControlOrMeta+a"); await page.keyboard.press("ArrowRight"); await page.keyboard.press("Escape");
    await expect.poll(async () => (await get()).revision).toBeGreaterThan(before.revision);
    const edited = await get(); expect(edited.scene.elements.find(e => e.id === "entry")?.x).toBeGreaterThan(before.scene.elements.find(e => e.id === "entry")!.x);
    const download = page.waitForEvent("download"); await nativeMenu(page, "Download source");
    const source = JSON.parse(await readFile((await (await download).path())!, "utf8"));
    expect(source.elements.find((e: { id: string }) => e.id === "entry").groupIds).toEqual(elements[0]!.groupIds);
    await nativeMenu(page, "Save / Save as to workspace");
    const save = page.getByRole("dialog", { name: "Save diagram", exact: true });
    await save.getByRole("textbox", { name: "Workspace path", exact: true }).fill("diagrams/groups.excalidraw");
    await save.getByRole("button", { name: "Save", exact: true }).click(); await expect(save).toHaveCount(0);
    const reopened = await action("open", { path: "diagrams/groups.excalidraw" });
    expect(reopened.scene).toEqual((await get()).scene);
    const png = page.waitForEvent("download"); await nativeMenu(page, "Export PNG");
    expect((await readFile((await (await png).path())!)).length).toBeGreaterThan(1000);
    await page.screenshot({ path: info.outputPath(`groups-light-editor-${width}.png`) });
    await expect(panel.getByRole("alert")).toHaveCount(0);
    expect(errors).toEqual([]); expect(external).toEqual([]);
  } finally { await page.close(); await bridge.close(); await rm(cwd, { recursive: true, force: true }); }
});
