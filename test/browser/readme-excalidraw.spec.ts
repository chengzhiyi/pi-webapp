/** Opt-in real-UI README capture. Uses an explicit local plugin archive, no model/registry calls.
 * CAPTURE_README_EXCALIDRAW=1 HOSTED_EXCALIDRAW_TGZ=/path/plugin.tgz \
 *   npx playwright test test/browser/readme-excalidraw.spec.ts --workers=1
 */
import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { hostedParity } from "../helpers/hosted-parity.ts";

const elements: Record<string, unknown>[] = [
  { type: "text", id: "heading", x: 20, y: 16, width: 1000, height: 45, text: "From idea to editable diagram", fontSize: 32, strokeColor: "#1e293b" },
  { type: "text", id: "intro", x: 20, y: 70, width: 1000, height: 30, text: "Stay in the conversation. Keep control of the canvas.", fontSize: 20, strokeColor: "#64748b" },
];
for (const [i, title, body, fill, stroke] of [
  [0, "1. Describe", "Ask Pi in plain language", "#eaf2f9", "#93b5d4"],
  [1, "2. Refine", "Edit shapes, text & layout", "#f0ebf8", "#b8b0d1"],
  [2, "3. Keep", "Save source / Export PNG", "#edf6f0", "#abc4b7"],
] as const) {
  const x = 20 + i * 330;
  elements.push(
    { type: "rectangle", id: `step-${i}`, x, y: 150, width: 280, height: 150, backgroundColor: fill, strokeColor: stroke, fillStyle: "solid", roundness: { type: 3 }, roughness: 1 },
    { type: "text", id: `title-${i}`, x: x + 24, y: 180, width: 245, height: 40, text: title, fontSize: 28, strokeColor: "#334155" },
    { type: "text", id: `body-${i}`, x: x + 24, y: 237, width: 250, height: 28, text: body, fontSize: 18, strokeColor: "#475569" },
  );
  if (i < 2) elements.push({ type: "arrow", id: `arrow-${i}`, x: x + 285, y: 225, points: [[0, 0], [40, 0]], endArrowhead: "arrow", strokeColor: "#7b8fa1" });
}
elements.push({ type: "text", id: "footer", x: 20, y: 345, width: 1100, height: 28, text: "Native Excalidraw canvas  /  Editable text & shapes  /  No drawing-service account", fontSize: 18, strokeColor: "#64748b" });

test.use({ deviceScaleFactor: 2 });

test("capture Excalidraw preview and verify native editor for README", async ({ page }) => {
  test.skip(process.env.CAPTURE_README_EXCALIDRAW !== "1" || !process.env.HOSTED_EXCALIDRAW_TGZ, "Opt-in documentation capture with an independently built plugin archive");
  test.setTimeout(120_000);
  const h = await hostedParity(page, { width: 1600, theme: "light", prompt: "Draw a simple workflow: describe an idea, refine it on the canvas, then save or export it." });
  const output = fileURLToPath(new URL("../../assets/readme/", import.meta.url));
  try {
    await mkdir(output, { recursive: true });
    await page.setViewportSize({ width: 1440, height: 760 });
    const created = await h.tool("excalidraw_create_view", { title: "From idea to editable diagram", elements: JSON.stringify(elements) });
    await page.goto(h.bridge.url);
    const preview = page.frameLocator('iframe[title="Excalidraw tool"]');
    await expect(preview.getByRole("img")).toBeVisible();
    await preview.locator("body").evaluate(() => document.fonts.ready);
    await page.mouse.move(0, 0);
    await page.locator("[data-hosted-tool-card]").screenshot({ path: `${output}excalidraw.png`, animations: "disabled" });
    const editor = await h.open();
    await expect(editor.locator("canvas.interactive")).toBeVisible();
    await editor.locator("canvas.interactive").evaluate(async () => {
      for (const face of Array.from(document.fonts)) await document.fonts.load(`20px ${face.family}`, "Drawing");
      await document.fonts.ready;
    });
    await editor.locator("canvas.interactive").click({ position: { x: 20, y: 200 } });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Shift+1");
    await page.mouse.move(0, 0);
    await page.evaluate(() => document.fonts.ready);
    await editor.locator("canvas.interactive").evaluate(() => document.fonts.ready);
    // Confirm the preview/editor use a real persisted native scene.
    await expect.poll(async () => (await h.action("get", { id: created.id })).scene.elements.length).toBeGreaterThan(0);
    expect(h.errors).toEqual([]);
    expect(h.external).toEqual([]);
  } finally { await h.close(); }
});
