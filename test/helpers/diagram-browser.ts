import { expect, type Page } from "@playwright/test";
import type { Bridge, BridgeHost } from "../../src/host/server/transport/bridge.ts";
export function publishDrawing(host: BridgeHost, bridge: Bridge, result: { id: string }, title: string, tool = "excalidraw_create_view", input: object = {}) {
  const session = host.snapshot(), timestamp = new Date().toISOString();
  session.idle = true; session.streaming = null;
  session.messages = [
    { id: `u-${result.id}`, role: "user", timestamp, blocks: [{ kind: "text", text: `请画${title}` }] },
    { id: `a-${result.id}`, role: "assistant", timestamp, blocks: [{ kind: "toolCall", toolName: tool, toolCallId: `draw-${result.id}`, text: JSON.stringify(input) }] },
    { id: `t-${result.id}`, role: "tool", timestamp, toolName: tool, toolCallId: `draw-${result.id}`, blocks: [{ kind: "text", text: JSON.stringify({ ...result, title }) }] },
    { id: `done-${result.id}`, role: "assistant", timestamp, blocks: [{ kind: "text", text: "图稿已呈现，可直接编辑。" }] },
  ];
  bridge.publish({ type: "snapshot", session });
}
/** Semantic test operations now drive official dialogs, not the removed custom menu. */
export async function nativeMenu(page: Page, name: string) {
  const editor = page.locator('[data-sidebar-right-session] .excalidraw');
  if (name === "Save / Save as to workspace") {
    await editor.locator('canvas.interactive').click();
    await page.keyboard.press('ControlOrMeta+s');
    return;
  }
  // Callers select the portable fallback in addInitScript, before upstream feature detection.
  await editor.getByTestId('main-menu-trigger').click();
  if (name === 'Import source') {
    await editor.getByTestId('load-button').click();
    const confirm = page.locator('.OverwriteConfirm__Description button');
    if (await confirm.isVisible()) await confirm.click();
    return;
  }
  if (name === 'Download source') {
    await editor.getByTestId('json-export-button').click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('.Card-button').click();
    await expect(dialog).toHaveCount(0);
    return;
  }
  if (name === 'Export PNG' || name === 'Export transparent PNG') {
    await editor.getByTestId('image-export-button').click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('input[name="exportBackgroundSwitch"]').setChecked(name === 'Export PNG');
    await dialog.getByText('PNG', { exact: true }).click();
    if (await dialog.locator('.Dialog__close').count()) await dialog.locator('.Dialog__close').click();
    else await page.locator('.excalidraw-modal-container .Modal__background').click({ position: { x: 5, y: 5 } });
    await expect(dialog).toHaveCount(0);
    return;
  }
  await page.getByText(name, { exact: true }).click();
}
