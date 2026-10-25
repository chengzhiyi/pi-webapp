import { test, expect } from "@playwright/test";
import { boxes, hostedParity } from "../helpers/hosted-parity.ts";

test("ORI-34: unlabeled shape x-only candidate applies without phantom bound text", async ({ page }) => {
  test.skip(!process.env.HOSTED_EXCALIDRAW_TGZ, "Explicit archive required");
  test.setTimeout(100_000);
  const h = await hostedParity(page);
  try {
    const created = await h.tool("excalidraw_create_view", boxes());
    await page.goto(h.bridge.url); await h.open();
    await expect.poll(async () => ((await h.action("get", { id: created.id })).scene.appState.scrollX ?? 0)).not.toBe(0);
    await expect.poll(async () => (await h.action("get", { id: created.id })).scene.appState.zoom?.value).toBe(1);
    const before = await h.action("get", { id: created.id });
    await h.tool("diagram_patch", { id: created.id, baseRevision: before.revision, patch: { updateElements: [{ id: "box-0", x: 222 }] } });
    const review = page.frameLocator('iframe[title="Excalidraw tool"]').last();
    await expect(review.getByRole("img")).toBeVisible();
    await review.getByRole("button", { name: "Apply edits", exact: true }).click();
    await expect.poll(async () => (await h.action("get", { id: created.id })).scene.elements[0].x).toBe(222);
    const after = await h.action("get", { id: created.id });
    expect(after.candidate).toBe(null);
    expect(after.scene.elements.filter((e: any) => !e.isDeleted && e.type === "text")).toHaveLength(0);
    expect(after.scene.elements[0].groupIds).toEqual(before.scene.elements[0].groupIds);
    expect((after.scene.elements[0].boundElements ?? []).filter((b: any) => b.type === "text")).toHaveLength(0);
    expect(h.errors).toEqual([]); expect(h.external).toEqual([]);
  } finally { await h.close(); }
});

test("ORI-34: synchronized native zoom/pan restores identical canvas pixels across generation", async ({ page }, info) => {
  test.skip(!process.env.HOSTED_EXCALIDRAW_TGZ, "Explicit archive required");
  test.setTimeout(100_000);
  const h = await hostedParity(page);
  try {
    const created = await h.tool("excalidraw_create_view", boxes(100));
    await page.goto(h.bridge.url); const editor = await h.open();
    const canvas = editor.locator("canvas.interactive");
    // Read only after native initialization has reached its first persisted viewport.
    await expect.poll(async () => (await h.action("get", { id: created.id })).scene.appState.zoom?.value).toBeGreaterThan(0);
    const initial = await h.action("get", { id: created.id });
    await canvas.click(); await page.keyboard.press("ControlOrMeta+-");
    await expect.poll(async () => (await h.action("get", { id: created.id })).scene.appState.zoom.value).toBeLessThan(initial.scene.appState.zoom.value);
    const zoomed = await h.action("get", { id: created.id });
    const bounds = (await canvas.boundingBox())!;
    await page.keyboard.down("Space"); await page.mouse.move(bounds.x + 200, bounds.y + 400);
    await page.mouse.down(); await page.mouse.move(bounds.x + 240, bounds.y + 440, { steps: 5 });
    await page.mouse.up(); await page.keyboard.up("Space"); await page.mouse.move(0, 0);
    await expect.poll(async () => (await h.action("get", { id: created.id })).scene.appState.scrollX).not.toBe(zoomed.scene.appState.scrollX);
    const before = await h.action("get", { id: created.id });
    expect(before.scene.elements).toHaveLength(100);
    expect(before.scene.elements.every((e: any) => e.groupIds.length === 1)).toBe(true);
    const staticCanvas = editor.locator("canvas.static").first();
    const pixels = await staticCanvas.screenshot();
    await info.attach("before-native-canvas", { body: pixels, contentType: "image/png" });
    const boot = await page.evaluate(() => ((window as any).__parityBoot = crypto.randomUUID()));
    const generation = (await h.card()).generation!;
    h.upgrade(); await h.manage("update", { reopenEditors: true });
    await expect.poll(async () => (await h.card()).generation).toBe(generation + 1);
    await expect(page.locator('iframe[title="Excalidraw editor"]')).toHaveAttribute("src", new RegExp(`generation=${generation + 1}(?:&|$)`));
    await expect(canvas).toBeVisible();
    // A settled native render, not merely the backend checkpoint echoing itself.
    await canvas.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const restoredPixels = await staticCanvas.screenshot();
    await info.attach("restored-native-canvas", { body: restoredPixels, contentType: "image/png" });
    expect(restoredPixels.equals(pixels), "Native geometry must render at the same zoom and pan").toBe(true);
    const after = await h.action("get", { id: created.id });
    expect(after.scene).toEqual(before.scene); expect(after.revision).toBe(before.revision);
    expect(h.sessions.session).toBe(h.retained);
    expect(await page.evaluate(() => (window as any).__parityBoot)).toBe(boot);
    expect((await h.rawAction("sync", { id: created.id, revision: before.revision, scene: before.scene }, generation)).status).toBe(409);
    expect(h.errors).toEqual([]); expect(h.external).toEqual([]);
    await info.attach("viewport-checkpoint", { body: JSON.stringify(before), contentType: "application/json" });
  } finally { await h.close(); }
});
