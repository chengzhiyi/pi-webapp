import { useEffect, useRef, useState } from "react";
import type { ViewMessage } from "../../../contracts/bridge-contract.ts";
import { hostedFrames } from "./frame-adapter.ts";

export function removedToolCalls(previous: ViewMessage[], next: ViewMessage[], tools: readonly string[]) {
  const calls = (messages: ViewMessage[]) => messages.flatMap(message => message.blocks.filter(block => block.kind === "toolCall" && tools.includes(block.toolName ?? "")).map(block => block.toolCallId!));
  const current = new Set(calls(next));
  return calls(previous).filter(id => !current.has(id));
}

/** Keep the actual React owners/realms until their identity-bound close completes. */
export function useHostedTranscript(sessionId: string | undefined, incoming: ViewMessage[], tools: readonly string[]) {
  const latest = useRef(incoming); latest.current = incoming;
  const [state, setState] = useState({ sessionId, messages: incoming, retiring: [] as string[] });
  const [error, setError] = useState("");
  const [attempt, retry] = useState(0);
  if (state.sessionId !== sessionId) setState({ sessionId, messages: incoming, retiring: [] });
  else if (!state.retiring.length && JSON.stringify(state.messages) !== JSON.stringify(incoming)) {
    const removed = removedToolCalls(state.messages, incoming, tools);
    // Retire the old projection's tool owners as one boundary. Additional snapshots
    // may remove more calls while a close is in flight; none may slip past the gate.
    const retiring = removed.length ? removedToolCalls(state.messages, [], tools) : [];
    setState(retiring.length ? { ...state, retiring } : { ...state, messages: incoming });
  }
  const signature = JSON.stringify(state.retiring);
  useEffect(() => {
    if (!sessionId || !state.retiring.length) return;
    let active = true;
    void hostedFrames.retireTools(sessionId, state.retiring).then(() => {
      if (active) {
        setError("");
        setState(current => ({ ...current, messages: latest.current, retiring: [] }));
      }
    }).catch(cause => { if (active) setError(`Removed plugin view retained for recovery: ${String(cause)}`); });
    return () => { active = false; };
  }, [sessionId, signature, attempt]);
  return { messages: state.messages, error, retry: () => retry(value => value + 1) };
}
