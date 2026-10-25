import type { ViewBlock, ViewMessage, ViewUsage } from "./pi-bridge.ts";

export interface ConversationTurn {
  id: string;
  index: number;
  messages: ViewMessage[];
  usage: ViewUsage | null;
}

export function conversationTurns(messages: ViewMessage[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (const message of messages) {
    if (message.role === "user" || turns.length === 0) {
      turns.push({ id: message.id, index: turns.length + 1, messages: [], usage: null });
    }
    const turn = turns[turns.length - 1]!;
    turn.messages.push(message);
    if (message.usage) {
      const previous = turn.usage;
      turn.usage = {
        input: (previous?.input ?? 0) + message.usage.input,
        output: (previous?.output ?? 0) + message.usage.output,
        cacheRead: (previous?.cacheRead ?? 0) + message.usage.cacheRead,
        cacheWrite: (previous?.cacheWrite ?? 0) + message.usage.cacheWrite,
        totalTokens: (previous?.totalTokens ?? 0) + message.usage.totalTokens,
        cost: (previous?.cost ?? 0) + message.usage.cost,
        ...(previous?.reasoning !== undefined || message.usage.reasoning !== undefined
          ? { reasoning: (previous?.reasoning ?? 0) + (message.usage.reasoning ?? 0) } : {}),
      };
    }
  }
  return turns;
}

/** A stream snapshot can briefly overlap its committed message. Tool identity, not
 * identical arguments or tool name, owns the view. Separate calls remain separate. */
export function toolViewCalls(messages: ViewMessage[], tools: readonly string[]): { key: string; call: ViewBlock }[] {
  const calls = new Map<string, { key: string; call: ViewBlock; streaming: boolean }>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    message.blocks.forEach((call, index) => {
      if (call.kind !== "toolCall" || !tools.includes(call.toolName ?? "")) return;
      const key = call.toolCallId ?? `${message.id}-${index}`;
      const prior = calls.get(key), streaming = message.id === "stream";
      if (!prior || prior.streaming || !streaming) calls.set(key, { key, call, streaming });
    });
  }
  return [...calls.values()].map(({ key, call }) => ({ key, call }));
}

/** Stream/provider snapshots may replace the provisional user/message IDs while
 * retaining the same tool call. Its owning turn must keep the same React subtree,
 * not merely the inner thumbnail key. Separate calls still own separate realms. */
export function toolViewTurnKey(turn: ConversationTurn, tools: readonly string[]): string {
  const first = toolViewCalls(turn.messages, tools)[0];
  return first ? `tool:${first.key}` : `message:${turn.id}`;
}

export function toolResults(messages: ViewMessage[]): Map<string, ViewMessage> {
  const callIds = new Set(messages.flatMap((message) => message.blocks.filter((block) => block.kind === "toolCall" && block.toolCallId).map((block) => block.toolCallId!)));
  return new Map(messages.filter((message) => message.role === "tool" && message.toolCallId && callIds.has(message.toolCallId))
    .map((message) => [message.toolCallId!, message]));
}
