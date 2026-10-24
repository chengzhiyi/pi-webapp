import type { ConnectionState, SessionView, ViewMessage } from "./pi-bridge.ts";

/** Bridge the optimistic send and empty-stream gaps without duplicating live content. */
export function conversationActivity(
  session: SessionView | null,
  streaming: ViewMessage | null,
  connection: ConnectionState,
  pending: boolean,
): "sending" | "working" | null {
  if (!session || connection !== "connected" || session.interactions?.length) return null;
  if (streaming?.error || streaming?.blocks.some(block => block.kind === "toolCall" || block.text.trim())) return null;
  if (pending) return "sending";
  return session.idle ? null : "working";
}
