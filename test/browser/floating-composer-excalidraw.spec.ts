import { test, expect } from "@playwright/test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hostedParity } from "../helpers/hosted-parity.ts";

// A drawing-capable Excalidraw archive (0.1.3+ has diagram_patch); the local fixture is untracked.
const archive = process.env.HOSTED_EXCALIDRAW_PATCH_TGZ
  ?? fileURLToPath(new URL("../../artifacts/upgrade-recovery/hosted-public-fixtures/chengzhiyi-pi-excalidraw-0.1.3.tgz", import.meta.url));
const shots = process.env.PI_FLOATING_SHOTS;

test("an agent patch to the open drawing is applied from the floating composer, onto the canvas", async ({ page }) => {
  test.skip(!existsSync(archive), "Excalidraw archive with diagram_patch required");
  test.setTimeout(120_000);
  const h = await hostedParity(page, { width: 1440, locale: "en", archive });
  try {
    const created = await h.tool("diagram_create", { title: "Login", graph: {
      nodes: [{ id: "start", label: "开始", kind: "terminal" }, { id: "done", label: "结束", kind: "terminal" }],
      edges: [{ id: "e1", from: "start", to: "done" }],
    } });
    await page.goto(h.bridge.url);
    // Open the drawing in the workspace panel, then hide the chat behind it.
    const editor = await h.open();
    const panel = page.locator("[data-sidebar-right-session]");
    await panel.getByRole("button", { name: "Fullscreen", exact: true }).click();
    await expect(panel).toHaveAttribute("data-sidebar-right-panel", "fullscreen");
    const floating = page.locator("[data-floating-composer]");
    await expect(floating).toHaveAttribute("data-floating-composer", "expanded");
    await expect(floating.locator("[data-floating-context]")).toContainText("Excalidraw");
    // The resize into fullscreen is an editor change; let its debounced sync land first, as it
    // would long before a person's next instruction does.
    await page.waitForTimeout(1_500);

    // The agent patches the open drawing; the plugin only proposes it, in its tool card.
    const read = await h.tool("diagram_read", { id: created.id });
    await h.tool("diagram_patch", { id: created.id, baseRevision: read.revision, patch: { updateNodes: [{ id: "start", label: "Start" }, { id: "done", label: "End" }] } });

    // The floating composer opens the conversation at that card, so Apply is on this page.
    const transcript = floating.locator("[data-floating-transcript]");
    await expect(transcript).toBeVisible();
    const card = transcript.locator('[data-tool-view="diagram_patch"]');
    await expect(card).toBeVisible();
    const preview = card.frameLocator('iframe[title="Excalidraw tool"]');
    const apply = preview.getByRole("button", { name: "Apply edits", exact: true });
    await expect(apply).toBeEnabled({ timeout: 15_000 });
    // The card's action row is fully on screen, not clipped by the conversation's edge.
    await expect(preview.getByRole("button", { name: "Keep original", exact: true })).toBeInViewport({ ratio: 1 });
    if (shots) {
      await page.waitForTimeout(2_500);
      await page.screenshot({ path: `${shots}/8-excalidraw-review.png` });
    }
    await apply.click();

    // Accepted: the canvas behind the composer is the patched drawing.
    await expect.poll(async () => (await h.tool("diagram_read", { id: created.id })).elements
      .filter((element: { type: string; text?: string }) => element.type === "text").map((element: { text?: string }) => element.text).sort().join(",")).toBe("End,Start");
    await expect(editor.locator("canvas.interactive")).toBeVisible();
    if (shots) {
      await page.waitForTimeout(4_000);
      await page.screenshot({ path: `${shots}/9-excalidraw-applied.png` });
    }
    expect(h.errors).toEqual([]);
  } finally { await h.close(); }
});

// 0.1.6+: edits to a drawing open on a canvas apply there directly; no chat step.
const canvasArchive = process.env.HOSTED_EXCALIDRAW_CANVAS_TGZ ?? "";

test("with the canvas-applying plugin, an agent edit lands on the open canvas and nothing waits in chat", async ({ page }) => {
  test.skip(!canvasArchive || !existsSync(canvasArchive), "HOSTED_EXCALIDRAW_CANVAS_TGZ (pi-excalidraw 0.1.6+) required");
  test.setTimeout(120_000);
  const h = await hostedParity(page, { width: 1440, locale: "en", archive: canvasArchive });
  try {
    const created = await h.tool("diagram_create", { title: "Login", graph: {
      nodes: [{ id: "start", label: "开始", kind: "terminal" }, { id: "done", label: "结束", kind: "terminal" }],
      edges: [{ id: "e1", from: "start", to: "done" }],
    } });
    await page.goto(h.bridge.url);
    await h.open();
    const panel = page.locator("[data-sidebar-right-session]");
    await panel.getByRole("button", { name: "Fullscreen", exact: true }).click();
    const floating = page.locator("[data-floating-composer]");
    await expect(floating).toHaveAttribute("data-floating-composer", "expanded");
    await page.waitForTimeout(1_500);

    const read = await h.tool("diagram_read", {});
    expect(read.id).toBe(created.id);
    expect(read.onCanvas).toBe(true);
    const patched = await h.tool("diagram_patch", { id: created.id, baseRevision: read.revision, patch: { updateNodes: [{ id: "start", label: "Start" }, { id: "done", label: "End" }] } });
    expect(patched.status).toBe("applied_on_canvas");
    await expect.poll(async () => (await h.tool("diagram_read", { id: created.id })).elements
      .filter((element: { type: string; text?: string }) => element.type === "text").map((element: { text?: string }) => element.text).sort().join(",")).toBe("End,Start");
    // Applied in place: the composer leaves the canvas uncovered instead of opening the chat at a card.
    await expect(floating.locator("[data-floating-transcript]")).toHaveCount(0);
    if (shots) { await page.waitForTimeout(2_000); await page.screenshot({ path: `${shots}/10-excalidraw-canvas-applied.png` }); }
    expect(h.errors).toEqual([]);
  } finally { await h.close(); }
});
