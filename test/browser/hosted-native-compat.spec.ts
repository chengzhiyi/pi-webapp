import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { boxes, hostedParity, pluginId } from "../helpers/hosted-parity.ts";

function canonical(value: any): any {
  return Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

test("ORI-39 A06/A14: native mixed 100-element import, edit, viewport and fenced delayed old actions", async ({ page }, info) => {
  test.skip(!process.env.HOSTED_EXCALIDRAW_TGZ, "Explicit archive required");
  test.setTimeout(100_000);
  const h = await hostedParity(page);
  try {
    const created = await h.tool("excalidraw_create_view", boxes());
    await page.goto(h.bridge.url); const editor = await h.open();
    await expect.poll(async () => (await h.action("get", { id: created.id })).scene.elements.length).toBe(1);
    const initial = await h.action("get", { id: created.id });
    const base = initial.scene.elements[0];
    const elements = Array.from({ length: 96 }, (_, i) => ({ ...base, id: `mixed-${i}`, x: (i % 10) * 150, y: Math.floor(i / 10) * 100, groupIds: [`group-${Math.floor(i / 4)}`], boundElements: i === 0 ? [{ id: "bound-arrow", type: "arrow" }] : [], backgroundColor: i % 2 ? "#dbeafe" : "#fff3bf" }));
    const scene = { ...initial.scene, elements: [...elements,
      { ...base, id: "中文-text", type: "text", x: 150, y: 20, width: 180, height: 30, text: "中文原生场景回归", originalText: "中文原生场景回归", fontSize: 24, fontFamily: 5, textAlign: "left", verticalAlign: "top", containerId: null, autoResize: true, lineHeight: 1.25, boundElements: [], groupIds: ["group-0"] },
      { ...base, id: "freehand", type: "freedraw", x: 350, y: 30, width: 80, height: 40, points: [[0, 0], [10, 20], [30, 5], [50, 40], [80, 0]], pressures: [0.4, 0.5, 0.7, 0.5, 0.4], simulatePressure: false, lastCommittedPoint: null, boundElements: [], groupIds: ["group-1"] },
      { ...base, id: "bound-end", type: "ellipse", x: 500, y: 20, width: 120, height: 70, boundElements: [{ id: "bound-arrow", type: "arrow" }], groupIds: [] },
      { ...base, id: "bound-arrow", type: "arrow", x: 130, y: 35, width: 360, height: 20, points: [[0, 0], [360, 20]], startBinding: { elementId: "mixed-0", focus: 0, gap: 10 }, endBinding: { elementId: "bound-end", focus: 0, gap: 10 }, startArrowhead: null, endArrowhead: "arrow", elbowed: false, boundElements: [], groupIds: [] },
    ], appState: { ...initial.scene.appState, viewBackgroundColor: "#f8f9fa" } };
    await editor.getByTestId("main-menu-trigger").click(); await editor.getByTestId("load-button").click();
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), editor.getByRole("dialog").getByRole("button", { name: "Load from file", exact: true }).click()]);
    await chooser.setFiles({ name: "中文混合100.excalidraw", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(scene)) });
    await expect.poll(async () => (await h.action("get", { id: created.id })).scene.elements.length).toBe(100);
    const canvas = editor.locator("canvas.interactive");
    await canvas.click(); await page.keyboard.press("ControlOrMeta+a"); await page.keyboard.press("ArrowRight"); await page.keyboard.press("Escape");
    await expect.poll(async () => (await h.action("get", { id: created.id })).scene.elements.find((e: any) => e.id === "mixed-0").x).not.toBe(0);
    await page.keyboard.press("Shift+1"); // Native fit-all: the assertion includes the entire mixed scene.
    await page.keyboard.press("ControlOrMeta+-");
    const bounds = (await canvas.boundingBox())!;
    const zoomed = await h.action("get", { id: created.id });
    await page.keyboard.down("Space"); await page.mouse.move(bounds.x + 200, bounds.y + 400); await page.mouse.down();
    await page.mouse.move(bounds.x + 250, bounds.y + 440, { steps: 5 }); await page.mouse.up(); await page.keyboard.up("Space"); await page.mouse.move(0, 0);
    await expect.poll(async () => (await h.action("get", { id: created.id })).scene.appState.scrollX).not.toBe(zoomed.scene.appState.scrollX);
    await canvas.click(); await page.keyboard.press("ControlOrMeta+s");
    const save = editor.getByRole("dialog", { name: "Save diagram", exact: true });
    await save.getByRole("textbox", { name: "Workspace path", exact: true }).fill("diagrams/中文混合100.excalidraw");
    await save.getByRole("button", { name: "Save", exact: true }).click(); await expect(save).toHaveCount(0);
    await page.mouse.move(0, 0);
    const before = await h.action("get", { id: created.id });
    expect(before.scene.elements).toHaveLength(100);
    expect(before.scene.elements.find((e: any) => e.id === "中文-text").text).toBe("中文原生场景回归");
    expect(before.scene.elements.find((e: any) => e.id === "freehand").points).toEqual(scene.elements.find((e: any) => e.id === "freehand")!.points);
    const arrow = before.scene.elements.find((e: any) => e.id === "bound-arrow");
    expect(arrow.startBinding.elementId).toBe("mixed-0"); expect(arrow.endBinding.elementId).toBe("bound-end");
    expect(before.scene.appState.viewBackgroundColor).toBe("#f8f9fa");
    // Read native backing pixels, not a DOM screenshot which also captures the intentionally
    // reset undo toolbar layered over the canvas after a generation change.
    const nativePixels = async () => Buffer.from(await editor.locator("canvas.static").first().evaluate((node: HTMLCanvasElement) => node.toDataURL("image/png").split(",")[1]), "base64");
    const pixels = await nativePixels();
    const file = join(h.root, "diagrams/中文混合100.excalidraw"), fileBytes = await readFile(file);
    const generation = (await h.card()).generation!;
    // Capture actual old-generation arguments now; deliver only after replacement commits.
    const delayed = { id: created.id, revision: before.revision, scene: { ...before.scene, elements: [] } };
    h.upgrade(); await h.manage("update", { reopenEditors: true });
    await expect.poll(async () => (await h.card()).generation).toBe(generation + 1);
    await expect(page.locator('iframe[title="Excalidraw editor"]')).toHaveAttribute("src", new RegExp(`generation=${generation + 1}(?:&|$)`));
    await expect(canvas).toBeVisible();
    await canvas.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const restored = await nativePixels();
    await info.attach("native-before", { body: pixels, contentType: "image/png" });
    await info.attach("native-restored", { body: restored, contentType: "image/png" });
    expect(restored.equals(pixels), "native canvas must render mixed geometry at the same viewport").toBe(true);
    const after = await h.action("get", { id: created.id });
    expect(hash(after.scene)).toBe(hash(before.scene)); expect(after.revision).toBe(before.revision);
    const broker = (h.integration.manager as any).supervisors.get(pluginId).broker;
    const active = await broker.active(), directory = join(broker.root, "states", active.stateRef);
    const stateBytes = async () => Object.fromEntries(await Promise.all((await readdir(directory)).sort().map(async name => [name, (await readFile(join(directory, name))).toString("base64")])));
    const checkpointBytes = await stateBytes();
    expect((await h.rawAction("sync", delayed, generation)).status).toBe(409);
    expect((await h.rawAction("save", { ...delayed, path: "diagrams/中文混合100.excalidraw" }, generation)).status).toBe(409);
    expect(await readFile(file)).toEqual(fileBytes); expect(await stateBytes()).toEqual(checkpointBytes);
    expect(await h.action("get", { id: created.id })).toEqual(after);
    expect(h.sessions.session).toBe(h.retained); expect(h.errors).toEqual([]); expect(h.external).toEqual([]);
    await info.attach("mixed-checkpoint-and-hash", { body: JSON.stringify({ before, after, sceneHash: hash(after.scene), fileHash: createHash("sha256").update(fileBytes).digest("hex") }), contentType: "application/json" });
  } finally { await h.close(); }
});
