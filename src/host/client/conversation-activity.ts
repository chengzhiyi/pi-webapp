import type { ConnectionState, SessionView, ViewMessage } from "./pi-bridge.ts";

/** Run lifetime is separate from placeholder visibility so elapsed time survives streaming. */
export function conversationIsWorking(
  session: SessionView | null,
  streaming: ViewMessage | null,
  connection: ConnectionState,
  pending: boolean,
): boolean {
  return !!session && connection === "connected" && !session.interactions?.length
    && !streaming?.error && (pending || !session.idle);
}

/** Bridge the optimistic send and empty-stream gaps without duplicating live content. */
export function conversationActivity(
  session: SessionView | null,
  streaming: ViewMessage | null,
  connection: ConnectionState,
  pending: boolean,
): "sending" | "working" | null {
  if (!conversationIsWorking(session, streaming, connection, pending)) return null;
  if (streaming?.blocks.some(block => block.kind === "toolCall" || block.text.trim())) return null;
  return pending ? "sending" : "working";
}
