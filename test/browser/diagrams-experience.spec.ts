import { test, expect } from "@playwright/test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBridge } from "../../src/host/server/transport/bridge.ts";
import { NodeTelemetry } from "../../src/platform/telemetry/telemetry.ts";
import { terminalHost } from "../helpers/terminal-host.ts";
import { DIAGRAM_PLUGIN, type DiagramDraft } from "../../src/plugins/builtin/diagrams/contract/diagrams.ts";
import { architectureExample } from "../../src/plugins/builtin/diagrams/contract/reference.ts";

for (const width of [1440, 390]) test(`reference experience: inline architecture, edit, targeted style/layout, PNG at ${width}px`, async ({ page }, info) => {
  test.setTimeout(90_000); page.setDefaultTimeout(15000);
  const cwd = await mkdtemp(join(tmpdir(), "pi-diagram-experience-"));
  const { host } = terminalHost(cwd);
  const bridge = await startBridge(host, new URL("../../web/dist/", import.meta.url).pathname, new NodeTelemetry({ env: { PI_WEB_SENTRY_ENABLED: "false" }, monitor: false }), { pluginSettingsFile: join(cwd, "plugins.json") });
  const url = new URL(bridge.url), headers = { Authorization: `Bearer ${url.hash.slice(1)}`, "Content-Type": "application/json" };
  const get = async (id: string): Promise<DiagramDraft> => fetch(url.origin + "/api/diagrams/get", { method: "POST", headers, body: JSON.stringify({ sessionId: "terminal-a", id }) }).then(r => r.json());
  const errors: string[] = [], external: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("request", r => { if (/^https?:/.test(r.url()) && !r.url().startsWith(url.origin)) external.push(r.url()); });
  await page.setViewportSize({ width, height: 1050 });
  await page.addInitScript(() => { localStorage.setItem("pi-web-locale", "en"); });
  try {
    const created = await bridge.runPluginTool(DIAGRAM_PLUGIN, cwd, "terminal-a", "create", { title: "Pi 分层架构", graph: architectureExample }) as { id: string };
    const session = host.snapshot(), timestamp = new Date().toISOString();
    session.messages = [
      { id: "u-rich", role: "user", timestamp, blocks: [{ kind: "text", text: "画一张 Pi 分层架构图，区分入口、核心、运行库、外部服务和实验路径" }] },
      { id: "a-rich", role: "assistant", timestamp, blocks: [{ kind: "toolCall", toolName: "diagram_create", toolCallId: "rich-call", text: JSON.stringify({ title: "Pi 分层架构", graph: architectureExample }) }] },
      { id: "t-rich", role: "tool", timestamp, toolName: "diagram_create", toolCallId: "rich-call", blocks: [{ kind: "text", text: JSON.stringify({ ...created, title: "Pi 分层架构" }) }] },
      { id: "done-rich", role: "assistant", timestamp, blocks: [{ kind: "text", text: "分层架构候选已生成：主流程、外部边界和实验路径分别表达。" }] },
    ];
    await page.goto(bridge.url);
    const artifact = page.getByRole("article", { name: "Diagram: Pi 分层架构", exact: true });
    await expect(artifact).toBeVisible();
    const image = artifact.getByRole("img", { name: "Pi 分层架构", exact: true });
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(1000);
    // A preview is visible before opening any editor, and does not mount a native canvas.
    await expect(page.locator(".excalidraw canvas")).toHaveCount(0);
    expect((await get(created.id)).scene.elements).toHaveLength(0);
    await artifact.getByRole("button", { name: "Zoom in preview", exact: true }).click();
    await expect(image).toHaveAttribute("style", /125%/);
    await artifact.getByRole("button", { name: "Fit preview", exact: true }).click();
    await page.screenshot({ path: info.outputPath(`inline-${width}.png`) });
    await artifact.getByRole("button", { name: "Open editor", exact: true }).click();
    const panel = page.locator("[data-sidebar-right-session]");
    await expect(panel.getByRole("textbox", { name: "Save path", exact: true })).not.toBeVisible();
    await expect(panel.getByRole("button", { name: "Accept candidate", exact: true })).toBeEnabled();
    await panel.getByRole("button", { name: "Accept candidate", exact: true }).click();
    await expect(panel.getByRole("button", { name: "Accept candidate", exact: true })).toHaveCount(0);
    let draft = await get(created.id);
    for (const n of architectureExample.nodes) {
      const element = draft.scene.elements.find(e => e.id === n.id)!;
      expect(element).toBeTruthy();
      expect(draft.scene.elements.some(e => e.text === n.label)).toBe(true);
      if (n.kind === "group") {
        expect(element.backgroundColor).toBe(n.backgroundColor);
        expect(draft.scene.elements.find(e => e.containerId === n.id)?.verticalAlign).toBe("top");
      }
    }
    const nativeTitle = draft.scene.elements.find(e => e.id === "title")!;
    expect(nativeTitle.type).toBe("text"); expect(nativeTitle.fontSize).toBe(36);
    expect(draft.scene.elements.find(e => e.id === "experiment")?.strokeStyle).toBe("dashed");
    expect(draft.scene.elements.find(e => e.id === "experimental")?.strokeStyle).toBe("dashed");
    expect(draft.scene.elements.find(e => e.id === "cli")?.groupIds).toEqual(["group-entry"]);
    // Compare both surfaces after acceptance, without building independent scene copies.
    await expect(artifact).toContainText("Editable diagram");
    const before = structuredClone(draft.scene.elements.find(e => e.id === "manager"));
    expect((draft.scene.elements.find(e => e.id === "dispatch")?.points as unknown[]).length).toBe(3);
    await expect(image).toHaveAttribute("data-scene-revision", `${draft.revision}:current`);
    const previousPreview = await image.getAttribute("src");
    await bridge.runPluginTool(DIAGRAM_PLUGIN, cwd, "terminal-a", "patch", { id: draft.id, baseRevision: draft.revision, patch: { updateElements: [
      { id: "title", label: "Pi 架构 · 已优化", fontSize: 32 },
      { id: "cli", x: 140, width: 340, backgroundColor: "#dbeafe" },
    ] } });
    await expect(panel.getByRole("button", { name: "Accept candidate", exact: true })).toBeEnabled();
    await panel.getByRole("button", { name: "Accept candidate", exact: true }).click();
    await expect.poll(async () => (await get(created.id)).scene.elements.find(e => e.id === "title")?.text).toBe("Pi 架构 · 已优化");
    draft = await get(created.id);
    expect(draft.scene.elements.find(e => e.id === "cli")?.x).toBe(140);
    expect(draft.scene.elements.find(e => e.id === "cli")?.backgroundColor).toBe("#dbeafe");
    expect(draft.scene.elements.find(e => e.id === "manager")).toEqual(before);
    expect(draft.scene.elements.find(e => e.id === "dispatch")?.startBinding).toMatchObject({ elementId: "cli" });
    await expect.poll(() => image.getAttribute("src")).not.toBe(previousPreview);
    await expect(image).toHaveAttribute("data-scene-revision", `${draft.revision}:current`);
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 1000)).toBe(true);
    const canvasBox = await panel.locator("[data-diagram-canvas]").boundingBox();
    expect(canvasBox!.height).toBeGreaterThan(450);
    await page.screenshot({ path: info.outputPath(`editor-${width}.png`) });
    const download = page.waitForEvent("download");
    await panel.getByRole("button", { name: "Export PNG", exact: true }).click();
    const png = await download; await png.saveAs(info.outputPath(`architecture-${width}.png`));
    expect((await readFile((await png.path())!)).length).toBeGreaterThan(20000);
    await panel.getByRole("button", { name: "Save / Save as", exact: true }).click();
    await expect(panel.getByRole("alert")).toContainText("Saved to workspace");
    await panel.getByText("Files & more", { exact: true }).click();
    const sourceDownload = page.waitForEvent("download"); await panel.getByRole("button", { name: "Download source", exact: true }).click();
    const source = await sourceDownload; await source.saveAs(info.outputPath(`architecture-${width}.excalidraw`));
    expect(errors).toEqual([]); expect(external).toEqual([]);
  } finally { await page.close(); await bridge.close(); await rm(cwd, { recursive: true, force: true }); }
});
