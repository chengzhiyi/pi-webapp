import type { Page } from "@playwright/test";
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
export async function nativeMenu(page: Page, name: string) {
  await page.locator('[data-sidebar-right-session] [data-testid="main-menu-trigger"]').click();
  await page.getByText(name, { exact: true }).click();
}
