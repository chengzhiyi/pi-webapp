import { test, expect } from "@playwright/test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBridge } from "../../src/host/server/transport/bridge.ts";
import { NodeTelemetry } from "../../src/platform/telemetry/telemetry.ts";
import { terminalHost } from "../helpers/terminal-host.ts";
import { DIAGRAM_PLUGIN, type DiagramDraft } from "../../src/plugins/builtin/diagrams/contract/diagrams.ts";
import { diagramReference } from "../../src/plugins/builtin/diagrams/contract/reference.ts";
import { publishDrawing } from "../helpers/diagram-browser.ts";

for (const width of [1440, 390]) test(`one stream/commit card, parameter modal and collapsible preview at ${width}px`, async ({ page }, info) => {
  test.setTimeout(60_000);
  const cwd = await mkdtemp(join(tmpdir(), "pi-diagram-cards-")), { host } = terminalHost(cwd);
  const bridge = await startBridge(host, new URL("../../web/dist/", import.meta.url).pathname, new NodeTelemetry({ env: { PI_WEB_SENTRY_ENABLED: "false" }, monitor: false }));
  await page.setViewportSize({ width, height: 1000 });
  await page.addInitScript(theme => { localStorage.setItem("pi-web-locale", "en"); localStorage.setItem("pi-web-theme", theme); }, width === 1440 ? "dark" : "light");
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  try {
    const session = host.snapshot(), timestamp = new Date().toISOString();
    session.idle = false;
    const call = { kind: "toolCall" as const, toolName: "excalidraw_create_view", toolCallId: "same-call", text: JSON.stringify(diagramReference.elementsExample) };
    session.messages = [{ id: "user", role: "user", timestamp, blocks: [{ kind: "text", text: "Draw a flow" }] }, { id: "committed", role: "assistant", timestamp, blocks: [call] }];
    session.streaming = { id: "stream", role: "assistant", timestamp, blocks: [{ ...call, text: JSON.stringify({ elements: "[" }) }] };
    await page.goto(bridge.url);
    const cards = page.locator('[data-tool-view="excalidraw_create_view"]');
    await expect(cards).toHaveCount(1); await expect(cards.locator("[data-stream-preview]")).toBeVisible();
    await expect(cards.locator("pre")).toHaveCount(0);
    const toggle = cards.getByRole("button", { name: "Toggle drawing preview", exact: true });
    await toggle.click(); await expect(cards.locator("[data-stream-preview]")).toBeHidden();
    const parameters = cards.getByRole("button", { name: "View parameters", exact: true });
    const dialog = page.getByRole("dialog", { name: "Drawing tool parameters", exact: true });
    await parameters.click();
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    await expect(dialog.locator("pre").first()).toHaveText(call.text);
    await expect(cards.locator("pre")).toHaveCount(0);
    const bounds = (await dialog.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect(bounds.y).toBeGreaterThanOrEqual(0); expect(bounds.y + bounds.height).toBeLessThanOrEqual(1000);
    const color = await dialog.evaluate(e => getComputedStyle(e).backgroundColor);
    expect(color === "rgb(255, 255, 255)").toBe(width === 390);
    const created = await bridge.runPluginTool(DIAGRAM_PLUGIN, cwd, "terminal-a", "view", diagramReference.elementsExample) as { id: string; title: string };
    session.messages.push({ id: "result", role: "tool", toolCallId: call.toolCallId, toolName: call.toolName, timestamp, blocks: [{ kind: "text", text: JSON.stringify(created) }] });
    // The final result can arrive before the stale stream has been cleared.
    bridge.publish({ type: "snapshot", session });
    await expect(cards).toHaveCount(1);
    await expect(cards.getByRole("article", { name: "Diagram: 登录流程", exact: true })).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(dialog.locator("pre")).toHaveCount(2);
    await expect(dialog.locator("pre").last()).toHaveText(JSON.stringify(created));
    const close = dialog.getByRole("button", { name: "Close", exact: true });
    await close.focus(); await page.keyboard.press("Shift+Tab");
    await expect(dialog.locator("pre").last()).toBeFocused();
    await page.keyboard.press("Tab"); await expect(close).toBeFocused();
    await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0);
    await expect(parameters).toBeFocused();
    await toggle.click(); await expect(cards.getByRole("img")).toBeVisible();
    await expect(cards.locator("pre")).toHaveCount(0);
    const height = (await cards.boundingBox())!.height;
    await page.screenshot({ path: info.outputPath(`single-card-${width}.png`) });
    await parameters.click();
    expect((await cards.boundingBox())!.height).toBe(height);
    await page.screenshot({ path: info.outputPath(`parameters-${width}.png`) });
    await close.click(); await expect(parameters).toBeFocused();
    await parameters.click();
    await page.getByRole("presentation").locator('[aria-hidden="true"]').first().click({ position: { x: 5, y: 5 } });
    await expect(dialog).toHaveCount(0); await expect(parameters).toBeFocused();
    // Separate real calls must not be merged merely because their arguments match.
    session.streaming = null; session.idle = true;
    session.messages.push({ id: "other-call", role: "assistant", timestamp, blocks: [{ ...call, toolCallId: "distinct-call" }] });
    bridge.publish({ type: "snapshot", session }); await expect(cards).toHaveCount(2);
    expect(errors).toEqual([]);
  } finally { await page.close(); await bridge.close(); await rm(cwd, { recursive: true, force: true }); }
});

test("Chinese parameter modal keeps failed/incomplete calls honest and historical prose intact", async ({ page }, info) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-diagram-inspector-")), { host } = terminalHost(cwd);
  const bridge = await startBridge(host, new URL("../../web/dist/", import.meta.url).pathname, new NodeTelemetry({ env: { PI_WEB_SENTRY_ENABLED: "false" }, monitor: false }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => { localStorage.setItem("pi-web-locale", "zh"); localStorage.setItem("pi-web-theme", "dark"); });
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  try {
    const session = host.snapshot(), timestamp = new Date().toISOString();
    const input = JSON.stringify({ elements: "[", literal: "<script>window.untrustedInspector=true</script>" });
    const call = { kind: "toolCall" as const, toolName: "excalidraw_create_view", toolCallId: "incomplete", text: input };
    const historical = '历史正文保留\n```json\n{"historical-scene":true}\n```';
    session.idle = true; session.streaming = null;
    session.messages = [{ id: "user", role: "user", timestamp, blocks: [{ kind: "text", text: "画图" }] }, { id: "old-prose", role: "assistant", timestamp, blocks: [{ kind: "text", text: historical }] }, { id: "call", role: "assistant", timestamp, blocks: [call] }];
    await page.goto(bridge.url);
    const card = page.locator('[data-tool-view="excalidraw_create_view"]');
    await expect(card.getByText("未完成", { exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "编辑 Excalidraw", exact: true })).toHaveCount(0);
    await expect(page.locator('[data-message-role="assistant"] pre')).toContainText('"historical-scene":true');
    await expect(card.locator("pre")).toHaveCount(0);
    await card.getByRole("button", { name: "查看参数", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "绘图工具参数", exact: true });
    await expect(dialog.locator("pre")).toHaveText(input);
    session.messages.push({ id: "failure", role: "tool", timestamp, toolCallId: call.toolCallId, toolName: call.toolName, isError: true, blocks: [{ kind: "text", text: "参数无效，图稿未创建" }] });
    bridge.publish({ type: "snapshot", session });
    await expect(dialog.locator("pre").last()).toHaveText("参数无效，图稿未创建");
    await expect(card.getByText("失败", { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("parameters-zh-failure.png") });
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(card.getByRole("alert")).toContainText("图稿未创建");
    await expect(card.getByRole("button", { name: "编辑 Excalidraw", exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => Reflect.get(window, "untrustedInspector"))).toBeUndefined();
    expect(host.snapshot().messages.find(m => m.id === "old-prose")!.blocks[0]!.text).toBe(historical);
    expect(errors).toEqual([]);
  } finally { await page.close(); await bridge.close(); await rm(cwd, { recursive: true, force: true }); }
});

for (const width of [1440, 390]) test(`official local menu, Mermaid insert and native frame sync at ${width}px`, async ({ page }, info) => {
  test.setTimeout(90_000); page.setDefaultTimeout(12000);
  const cwd = await mkdtemp(join(tmpdir(), "pi-diagram-menu-")), { host } = terminalHost(cwd);
  const bridge = await startBridge(host, new URL("../../web/dist/", import.meta.url).pathname, new NodeTelemetry({ env: { PI_WEB_SENTRY_ENABLED: "false" }, monitor: false }));
  const url = new URL(bridge.url), headers = { Authorization: `Bearer ${url.hash.slice(1)}`, "Content-Type": "application/json" };
  await page.setViewportSize({ width, height: 1000 });
  await page.addInitScript(() => {
    localStorage.setItem("pi-web-locale", "en");
    // Exercise the official portable download fallback, not an OS-native save dialog.
    Reflect.deleteProperty(window, "showSaveFilePicker");
    Reflect.deleteProperty(window, "showOpenFilePicker");
  });
  const errors: string[] = [], external: string[] = [];
  page.on("pageerror", e => errors.push(e.message)); page.on("request", r => { if (/^https?:/.test(r.url()) && !r.url().startsWith(url.origin)) external.push(r.url()); });
  try {
    const created = await bridge.runPluginTool(DIAGRAM_PLUGIN, cwd, "terminal-a", "view", diagramReference.elementsExample) as { id: string };
    publishDrawing(host, bridge, created, "登录流程", "excalidraw_create_view", diagramReference.elementsExample);
    await page.goto(bridge.url);
    await expect(page.getByRole("article", { name: "Diagram: 登录流程", exact: true }).getByRole("img")).toBeVisible();
    await page.getByRole("button", { name: "Edit Excalidraw", exact: true }).click();
    const panel = page.locator("[data-sidebar-right-session]"), editor = panel.locator(".excalidraw");
    await expect(editor.locator("canvas.interactive")).toBeVisible();
    const get = async (): Promise<DiagramDraft> => fetch(url.origin + "/api/diagrams/get", { method: "POST", headers, body: JSON.stringify({ sessionId: "terminal-a", id: created.id }) }).then(r => r.json());
    const menu = () => editor.getByTestId("main-menu-trigger").click();
    const closeDialog = async () => {
      if (width === 390) await page.getByRole("dialog").locator(".Dialog__close").click();
      else await page.locator(".excalidraw-modal-container .Modal__background").click({ position: { x: 5, y: 5 } });
      await expect(page.getByRole("dialog")).toHaveCount(0);
    };
    await menu();
    for (const id of ["load-button", "json-export-button", "image-export-button", "search-menu-button", "command-palette-button", "help-menu-item", "clear-canvas-button"]) await expect(editor.getByTestId(id)).toBeVisible();
    await expect(editor.getByTestId("collab-button")).toHaveCount(0);
    for (const label of ["Workspace & backups", "Import source", "Recover local backup", "Save / Save as to workspace", "Download source", "Export PNG", "Export transparent PNG"]) await expect(editor.getByText(label, { exact: true })).toHaveCount(0);
    // Official Save to active file only exists once the browser owns a file handle.
    await expect(editor.getByTestId("save-button")).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`native-menu-${width}.png`) });
    await editor.getByTestId("help-menu-item").click(); await expect(page.getByRole("dialog")).toBeVisible(); await closeDialog();
    await menu(); await editor.getByTestId("image-export-button").click();
    const exportDialog = page.getByRole("dialog"); await expect(exportDialog).toBeVisible();
    await expect(exportDialog.getByText("SVG", { exact: true })).toBeVisible();
    for (const format of ["SVG", "PNG"]) {
      const download = page.waitForEvent("download"); await exportDialog.getByText(format, { exact: true }).click();
      const bytes = await readFile((await (await download).path())!);
      if (format === "SVG") expect(bytes.toString()).toContain("<svg");
      else expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    }
    await closeDialog();
    // Official browser source save, not a silent workspace write.
    await menu(); await editor.getByTestId("json-export-button").click();
    const fileDialog = page.getByRole("dialog");
    await expect(fileDialog.locator(".Card")).toHaveCount(1); // No cloud/link card.
    const saving = page.waitForEvent("download"); await fileDialog.locator(".Card-button").click();
    const downloaded = JSON.parse(await readFile((await (await saving).path())!, "utf8"));
    expect(downloaded.elements.some((e: { id: string }) => e.id === "input")).toBe(true);
    await editor.locator(".App-toolbar__extra-tools-trigger").click();
    const embeds = editor.getByTestId("toolbar-embeddable");
    await expect(embeds.nth(0)).toBeHidden(); await expect(embeds.nth(1)).toBeVisible();
    await page.screenshot({ path: info.outputPath(`native-tools-${width}.png`) });
    await embeds.nth(1).click();
    const mermaid = page.getByRole("dialog"); await expect(mermaid.locator("textarea")).toBeVisible();
    await mermaid.locator("textarea").fill("flowchart LR\n A[本地输入] --> B[本地输出]");
    await expect(mermaid.locator(".ttd-dialog-output-canvas-container canvas")).toBeVisible();
    await mermaid.getByRole("button", { name: /Insert/i }).click();
    await expect(mermaid).toHaveCount(0);
    await expect.poll(async () => (await get()).scene.elements.some(e => e.text === "本地输入")).toBe(true);
    const beforeFrame = await get();
    await editor.locator(".App-toolbar__extra-tools-trigger").click(); await editor.getByTestId("toolbar-frame").click();
    const box = (await editor.locator("canvas.interactive").boundingBox())!;
    await page.mouse.move(box.x + 50, box.y + 300); await page.mouse.down(); await page.mouse.move(box.x + 240, box.y + 500); await page.mouse.up();
    await expect.poll(async () => (await get()).scene.elements.some(e => e.type === "frame")).toBe(true);
    expect((await get()).revision).toBeGreaterThan(beforeFrame.revision);
    await page.keyboard.press("Escape"); await page.keyboard.press("Escape");
    await expect(panel.getByRole("alert")).toHaveCount(0);
    // Official clear confirmation participates in normal synchronization and undo.
    await menu(); await editor.getByTestId("clear-canvas-button").click();
    const clear = page.getByRole("dialog"); await expect(clear).toBeVisible();
    await clear.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect.poll(async () => (await get()).scene.elements.filter(e => !e.isDeleted).length).toBe(0);
    await editor.locator("canvas.interactive").click(); await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(async () => (await get()).scene.elements.some(e => e.type === "frame" && !e.isDeleted)).toBe(true);
    expect(errors).toEqual([]); expect(external).toEqual([]);
  } finally { await page.close(); await bridge.close(); await rm(cwd, { recursive: true, force: true }); }
});
