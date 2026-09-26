import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { displayUserMessage } from "../shared/user-message.ts";

export interface ViewBlock {
  kind: "text" | "thinking" | "image" | "toolCall";
  text: string;
  toolName?: string;
  toolCallId?: string;
}

export interface ViewUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  totalTokens: number;
  cost: number;
}

export interface ViewMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "notice";
  timestamp: string;
  blocks: ViewBlock[];
  isError?: boolean;
  toolCallId?: string;
  toolName?: string;
  usage?: ViewUsage;
  model?: string;
  error?: string;
}

export interface SessionView {
  schemaVersion: 1;
  sessionId: string;
  cwd: string;
  name: string;
  model: string | null;
  thinkingLevel: string | null;
  thinkingLevels: string[];
  idle: boolean;
  contextUsage: { tokens: number | null; contextWindow: number; percent: number | null } | null;
  messages: ViewMessage[];
}

type ContentPart =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "image" }
  | { type: "toolCall"; id: string; name: string; arguments: unknown };

export function contentBlocks(content: string | readonly ContentPart[]): ViewBlock[] {
  if (typeof content === "string") return [{ kind: "text", text: content }];
  return content.flatMap((part): ViewBlock[] => {
    if (part.type === "text") return [{ kind: "text", text: part.text }];
    if (part.type === "thinking") {
      return [{ kind: "thinking", text: part.thinking }];
    }
    if (part.type === "image") return [{ kind: "image", text: "图片附件" }];
    if (part.type === "toolCall") {
      return [{ kind: "toolCall", text: JSON.stringify(part.arguments ?? {}), toolName: part.name, toolCallId: part.id }];
    }
    return [];
  });
}

export function projectEntry(entry: SessionEntry): ViewMessage | null {
  if (entry.type === "custom_message") {
    if (!entry.display) return null;
    return {
      id: entry.id,
      role: "notice",
      timestamp: entry.timestamp,
      blocks: contentBlocks(entry.content),
    };
  }
  if (entry.type !== "message") return null;
  const { message } = entry;
  if (message.role === "user" || message.role === "assistant") {
    return {
      id: entry.id,
      role: message.role,
      timestamp: entry.timestamp,
      blocks: contentBlocks(message.content),
      ...(message.role === "assistant" ? { ...(message.stopReason === "error" && message.errorMessage ? { error: message.errorMessage } : {}), usage: {
        input: message.usage.input,
        output: message.usage.output,
        cacheRead: message.usage.cacheRead,
        cacheWrite: message.usage.cacheWrite,
        ...(message.usage.reasoning === undefined ? {} : { reasoning: message.usage.reasoning }),
        totalTokens: message.usage.totalTokens,
        cost: message.usage.cost.total,
      }, model: `${message.provider}/${message.model}` } : {}),
    };
  }
  if (message.role === "toolResult") {
    return {
      id: entry.id,
      role: "tool",
      timestamp: entry.timestamp,
      blocks: contentBlocks(message.content),
      isError: message.isError,
      toolCallId: message.toolCallId,
      toolName: message.toolName,
    };
  }
  return null;
}

export function sessionTitle(name: string | undefined, messages: ViewMessage[]): string {
  const explicit = name?.trim();
  if (explicit) return explicit;
  const firstUser = messages.find((message) => message.role === "user");
  const text = displayUserMessage(firstUser?.blocks.find((block) => block.kind === "text")?.text ?? "").text.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 50) : "当前会话";
}

export function projectSession(ctx: ExtensionContext, name?: string): SessionView {
  const messages = ctx.sessionManager.getBranch().flatMap((entry) => {
    const message = projectEntry(entry);
    return message ? [message] : [];
  });
  return {
    schemaVersion: 1,
    sessionId: ctx.sessionManager.getSessionId(),
    cwd: ctx.cwd,
    name: sessionTitle(name, messages),
    model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
    thinkingLevel: ctx.thinkingLevel ?? null,
    thinkingLevels: ctx.model ? getSupportedThinkingLevels(ctx.model) : ["off"],
    idle: ctx.isIdle(),
    contextUsage: ctx.getContextUsage() ?? null,
    messages,
  };
}
