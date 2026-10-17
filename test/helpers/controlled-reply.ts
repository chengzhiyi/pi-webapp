import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

export async function controlledReply(session: AgentSession, text: string) {
  const model = session.modelRuntime.getModels("openai")[0]!;
  await session.modelRuntime.setRuntimeApiKey("openai", "fixture-no-network");
  await session.setModel(model);
  let finish!: () => void;
  let fail!: () => void;
  let aborted = false;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  session.agent.streamFunction = async (model, _context, options) => {
    const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
      content: [{ type: "text", text }], stopReason: "stop", timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: message });
    stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
    finish = () => { stream.push({ type: "done", reason: "stop", message }); stream.end(message); };
    fail = () => {
      const error = { ...message, stopReason: "error" as const, errorMessage: "Fixture response failed" };
      stream.push({ type: "error", reason: "error", error }); stream.end(error);
    };
    options?.signal?.addEventListener("abort", () => {
      aborted = true;
      const cancelled = { ...message, stopReason: "aborted" as const };
      stream.push({ type: "error", reason: "aborted", error: cancelled }); stream.end(cancelled);
    }, { once: true });
    started();
    return stream;
  };
  return { ready, finish: () => finish(), fail: () => fail(), wasAborted: () => aborted };
}
