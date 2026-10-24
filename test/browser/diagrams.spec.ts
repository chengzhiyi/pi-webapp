import { test, expect } from "@playwright/test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBridge } from "../../src/host/server/transport/bridge.ts";
import { NodeTelemetry } from "../../src/platform/telemetry/telemetry.ts";
import { terminalHost } from "../helpers/terminal-host.ts";
import { DIAGRAM_PLUGIN, type DiagramDraft, type DiagramGraph } from "../../src/plugins/builtin/diagrams/contract/diagrams.ts";

for (const width of [1440, 390]) test(`diagrams: lazy local canvas, accept, hand edit, patch, save and export at ${width}px`, async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  page.setDefaultTimeout(10000);
  const cwd = await mkdtemp(join(tmpdir(), "pi-diagram-browser-"));
  const { host } = terminalHost(cwd);
  const bridge = await startBridge(host, new URL("../../web/dist/", import.meta.url).pathname, new NodeTelemetry({ env: { PI_WEB_SENTRY_ENABLED: "false" }, monitor: false }), { pluginSettingsFile: join(cwd, "plugins.json") });
  const url = new URL(bridge.url), headers = { Authorization: `Bearer ${url.hash.slice(1)}`, "Content-Type": "application/json", Origin: url.origin };
  const action = async <T,>(name: string, input: object): Promise<T> => {
    const response = await fetch(url.origin + `/api/diagrams/${name}`, { method: "POST", headers, body: JSON.stringify({ sessionId: "terminal-a", ...input }) });
    expect(response.status).toBe(200); return response.json();
  };
  const graph: DiagramGraph = { nodes: [{ id: "order", label: "提交订单" }, { id: "pay", label: "支付成功？", kind: "decision" }, { id: "ship", label: "安排发货" }], edges: [{ id: "e1", from: "order", to: "pay" }, { id: "e2", from: "pay", to: "ship", label: "是" }, { id: "e3", from: "pay", to: "order", label: "否，重试" }] };
  const errors: string[] = [], external: string[] = [], requests: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("request", request => { requests.push(request.url()); if (!request.url().startsWith(url.origin) && /^https?:/.test(request.url())) external.push(request.url()); });
  await page.setViewportSize({ width, height: 1000 });
  await page.addInitScript(() => { localStorage.setItem("pi-web-locale", "en"); });
  const panel = page.locator("[data-sidebar-right-session]");
  const getDraft = (id: string) => action<DiagramDraft>("get", { id });
  try {
    await page.goto(bridge.url);
    await page.getByRole("button", { name: "Open right sidebar", exact: true }).click();
    await panel.getByRole("button", { name: "Diagrams", exact: true }).click();
    await expect(panel.getByRole("button", { name: "New diagram", exact: true })).toBeVisible();
    expect(requests.some(r => /\/Canvas[-.]/.test(r))).toBe(false);
    const created = await bridge.runPluginTool(DIAGRAM_PLUGIN, cwd, "terminal-a", "create", { title: "订单支付流程", graph }) as { id: string };
    if (width === 1440) {
      const session = host.snapshot();
      const timestamp = new Date().toISOString();
      session.messages = [
        { id: "user-diagram", role: "user", timestamp, blocks: [{ kind: "text", text: "画一个订单流程" }] },
        { id: "assistant-diagram", role: "assistant", timestamp, blocks: [{ kind: "toolCall", toolName: "diagram_create", toolCallId: "draw-call", text: JSON.stringify({ title: "订单支付流程", graph }) }] },
        { id: "result-diagram", role: "tool", toolName: "diagram_create", toolCallId: "draw-call", timestamp, blocks: [{ kind: "text", text: JSON.stringify({ id: created.id, title: "订单支付流程", status: "pending_canvas_acceptance" }) }] },
        { id: "done-diagram", role: "assistant", timestamp, blocks: [{ kind: "text", text: "请打开图稿预览。" }] },
      ];
      bridge.publish({ type: "snapshot", session });
      await page.getByRole("button", { name: "Open editor", exact: true }).click();
    } else await panel.getByRole("button", { name: /订单支付流程/ }).click();
    await expect(panel.getByRole("button", { name: "Accept candidate", exact: true })).toBeEnabled();
    await expect(panel.locator(".excalidraw canvas").first()).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`candidate-${width}.png`) });
    expect((await getDraft(created.id)).scene.elements).toHaveLength(0);
    await panel.getByRole("button", { name: "Accept candidate", exact: true }).click();
    await expect(panel.getByRole("button", { name: "Accept candidate", exact: true })).toHaveCount(0);
    await expect.poll(async () => (await getDraft(created.id)).scene.elements.length).toBeGreaterThan(5);
    let current = await getDraft(created.id);
    for (const label of ["提交订单", "支付成功？", "安排发货", "否，重试"]) expect(current.scene.elements.some(e => e.text === label)).toBe(true);
    const order = current.scene.elements.find(e => e.id === "order")!;
    // Real keyboard editing in the native editor; no test hook or alternate renderer.
    const nativeCanvas = panel.locator(".excalidraw canvas.interactive");
    await nativeCanvas.click();
    await page.keyboard.press("ControlOrMeta+a"); await page.keyboard.press("ArrowRight"); await page.keyboard.press("Escape");
    await expect.poll(async () => (await getDraft(created.id)).scene.elements.find(e => e.id === "order")?.x).not.toBe(order.x);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(async () => (await getDraft(created.id)).scene.elements.find(e => e.id === "order")?.x).toBe(order.x);
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect.poll(async () => (await getDraft(created.id)).scene.elements.find(e => e.id === "order")?.x).not.toBe(order.x);
    current = await getDraft(created.id);
    const handPosition = current.scene.elements.find(e => e.id === "order")!;
    const patch = { addNodes: [{ id: "refund", label: "发起退款" }], addEdges: [{ id: "e4", from: "pay", to: "refund", label: "取消支付" }] };
    await bridge.runPluginTool(DIAGRAM_PLUGIN, cwd, "terminal-a", "patch", { id: created.id, baseRevision: current.revision, patch });
    await expect(panel.getByRole("button", { name: "Reject candidate", exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "Reject candidate", exact: true }).click();
    expect((await getDraft(created.id)).scene.elements.some(e => e.id === "refund")).toBe(false);
    current = await getDraft(created.id);
    await bridge.runPluginTool(DIAGRAM_PLUGIN, cwd, "terminal-a", "patch", { id: created.id, baseRevision: current.revision, patch });
    await expect(panel.getByRole("button", { name: "Accept candidate", exact: true })).toBeEnabled();
    await panel.getByRole("button", { name: "Accept candidate", exact: true }).click();
    await expect.poll(async () => (await getDraft(created.id)).scene.elements.some(e => e.id === "refund")).toBe(true);
    current = await getDraft(created.id);
    expect(current.scene.elements.find(e => e.id === "order")?.x).toBe(handPosition.x);
    expect(current.scene.elements.find(e => e.id === "order")?.y).toBe(handPosition.y);
    expect(current.scene.elements.find(e => e.containerId === "order")?.text).toBe("提交订单");
    await expect(panel.getByRole("button", { name: "Accept candidate", exact: true })).toHaveCount(0);
    // Updating a label keeps the native shape ID and hand-edited position.
    await bridge.runPluginTool(DIAGRAM_PLUGIN, cwd, "terminal-a", "patch", { id: created.id, baseRevision: current.revision, patch: { updateNodes: [{ id: "order", label: "用户手动确认订单" }] } });
    await expect(panel.getByRole("button", { name: "Accept candidate", exact: true })).toBeEnabled();
    await panel.getByRole("button", { name: "Accept candidate", exact: true }).click();
    await expect.poll(async () => (await getDraft(created.id)).scene.elements.find(e => e.containerId === "order")?.text).toBe("用户手动确认订单");
    expect((await getDraft(created.id)).scene.elements.find(e => e.id === "order")?.x).toBe(handPosition.x);
    await panel.getByText("Files & more", { exact: true }).click();
    await panel.getByRole("textbox", { name: "Save path", exact: true }).fill("diagrams/order.excalidraw");
    await panel.getByRole("button", { name: "Save / Save as", exact: true }).click();
    await expect(panel.getByRole("alert")).toContainText("Saved to workspace");
    const saved = JSON.parse(await readFile(join(cwd, "diagrams/order.excalidraw"), "utf8"));
    expect(saved.elements.some((e: { id: string }) => e.id === "refund")).toBe(true);
    const pngDownload = page.waitForEvent("download");
    await panel.getByRole("button", { name: "Export PNG", exact: true }).click();
    const downloaded = await pngDownload;
    expect(downloaded.suggestedFilename()).toMatch(/\.png$/);
    const bytes = await readFile((await downloaded.path())!);
    expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]); expect(bytes.length).toBeGreaterThan(10000);
    await downloaded.saveAs(testInfo.outputPath(`export-${width}.png`));
    if (width === 1440) {
      await panel.getByRole("checkbox", { name: "Transparent", exact: true }).check();
      const transparentDownload = page.waitForEvent("download");
      await panel.getByRole("button", { name: "Export PNG", exact: true }).click();
      const image = await transparentDownload;
      const transparent = await readFile((await image.path())!);
      expect(await page.evaluate(async bytes => { const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: "image/png" })); const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height; const ctx = canvas.getContext("2d")!; ctx.drawImage(bitmap, 0, 0); return ctx.getImageData(0, 0, 1, 1).data[3]; }, [...transparent])).toBe(0);
      await image.saveAs(testInfo.outputPath("export-transparent.png"));
    }
    const sourceDownload = page.waitForEvent("download"); await panel.getByRole("button", { name: "Download source", exact: true }).click();
    const downloadedSource = await sourceDownload;
    await downloadedSource.saveAs(testInfo.outputPath(`example-${width}.excalidraw`));
    const source = JSON.parse(await readFile((await downloadedSource.path())!, "utf8"));
    expect(source.elements).toEqual(saved.elements);
    await page.screenshot({ path: testInfo.outputPath(`edited-${width}.png`) });
    // A non-cooperating external writer must not be silently overwritten.
    await writeFile(join(cwd, "diagrams/order.excalidraw"), JSON.stringify({ ...saved, source: "external-writer" }));
    await panel.getByRole("button", { name: "Save / Save as", exact: true }).click();
    await expect(panel.getByRole("alert")).toContainText("外部修改");
    expect(JSON.parse(await readFile(join(cwd, "diagrams/order.excalidraw"), "utf8")).source).toBe("external-writer");
    await page.reload();
    await page.getByRole("button", { name: "Open right sidebar", exact: true }).click();
    await panel.getByRole("button", { name: "Diagrams", exact: true }).click();
    await panel.getByRole("textbox", { name: "Workspace diagram path", exact: true }).fill("diagrams/order.excalidraw");
    await panel.getByRole("button", { name: "Open file", exact: true }).click();
    await expect(panel.locator(".excalidraw canvas").first()).toBeVisible();
    const listing = await action<DiagramDraft[]>("list", {}); expect(listing.length).toBeGreaterThan(0);
    const management = await fetch(url.origin + "/api/plugin-management", { headers }).then(r => r.json());
    const disabled = await fetch(url.origin + "/api/plugin-management", { method: "POST", headers, body: JSON.stringify({ sessionId: "terminal-a", id: DIAGRAM_PLUGIN, enabled: false, expected: management.revision }) });
    expect(disabled.status).toBe(200);
    await expect(panel.getByRole("region", { name: "Diagram editor", exact: true })).toHaveCount(0);
    await expect(panel.locator("[data-diagram-canvas]")).toHaveCount(0);
    expect(external).toEqual([]);
    expect(errors).toEqual([]);
  } finally { await page.close(); await bridge.close(); await rm(cwd, { recursive: true, force: true }); }
});
