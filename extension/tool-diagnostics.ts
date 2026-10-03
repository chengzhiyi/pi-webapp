import { createHash } from "node:crypto";
import { builtinToolNames, safeFields, sanitizeError, type DiagnosticFields, type ToolDiagnosticFields, type ToolFailureKind } from "../shared/telemetry.ts";

export interface ToolFailure {
  failureKind: ToolFailureKind;
  errorCode?: string;
  exitCode?: number;
  timeoutMs?: number;
  errorSummary?: string;
  summaryOmitted: boolean;
  summaryOmittedReason?: string;
  originalStackAvailable: boolean;
  level: "warning" | "error";
}
const systemErrors: Record<string, { kind: ToolFailureKind; summary: string }> = {
  ENOENT: { kind: "not_found", summary: "no such file or directory" },
  ENOTDIR: { kind: "not_found", summary: "not a directory" },
  EACCES: { kind: "permission", summary: "permission denied" },
  EPERM: { kind: "permission", summary: "operation not permitted" },
  ETIMEDOUT: { kind: "timeout", summary: "operation timed out" },
  EINVAL: { kind: "validation", summary: "invalid argument" },
};
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;

/** Never upload arbitrary output. Summaries are reconstructed from recognized diagnostic formats. */
export function classifyToolFailure(result: unknown, toolName: string): ToolFailure {
  const error = result instanceof Error ? result : object(result)?.error instanceof Error ? object(result)!.error as Error : undefined;
  const diagnostic: ToolFailure = { failureKind: "unknown", summaryOmitted: true, summaryOmittedReason: "unrecognized_diagnostic", originalStackAvailable: !!error?.stack, level: "error" };
  const accept = (kind: ToolFailureKind, code: string, summary: string): void => {
    Object.assign(diagnostic, { failureKind: kind, errorCode: code, errorSummary: summary.slice(0, 512), summaryOmitted: false, level: error ? "error" : "warning" });
    delete diagnostic.summaryOmittedReason;
  };
  // Structured Error.code is authoritative. Result details are not a diagnostic contract in Pi.
  const code = object(error)?.code;
  if (typeof code === "string" && systemErrors[code]) {
    const known = systemErrors[code]!;
    accept(known.kind, code, `${code}: ${known.summary}`);
    return diagnostic;
  }
  let text = error?.message ?? "";
  if (!error) {
    const content = object(result)?.content;
    if (Array.isArray(content)) {
      // Bounded inspection of text blocks; image data, arbitrary details and arguments are never read.
      text = content.slice(0, 8).flatMap(part => {
        const item = object(part);
        return item?.type === "text" && typeof item.text === "string" ? [item.text.length > 16_384 ? `${item.text.slice(0, 8192)}\n[truncated]\n${item.text.slice(-8192)}` : item.text] : [];
      }).join("\n");
    }
  }
  const shell = toolName === "bash" || toolName === "powershell";
  const tail = text.slice(-8192).trimEnd().split(/\r?\n/).at(-1) ?? "";
  if (shell) {
    const exit = tail.match(/^Command exited with code (-?\d{1,10})$/);
    const timeout = tail.match(/^Command timed out after (\d+(?:\.\d+)?) seconds$/);
    if (exit && Number.isSafeInteger(Number(exit[1])) && Number(exit[1]) !== 0) {
      accept("process_exit", "nonzero_exit", tail); diagnostic.exitCode = Number(exit[1]);
      return diagnostic;
    }
    if (timeout && Number.isFinite(Number(timeout[1])) && Number(timeout[1]) > 0) {
      accept("timeout", "timeout", tail); diagnostic.timeoutMs = Number(timeout[1]) * 1000;
      return diagnostic;
    }
    if (tail === "Command aborted") { accept("cancelled", "cancelled", tail); return diagnostic; }
  }
  // Non-shell errors have no mixed stdout. Only their first diagnostic line is recognized.
  const first = text.slice(0, 8192).split(/\r?\n/, 1)[0] ?? "";
  if (text === "Operation aborted" || error?.name === "AbortError") accept("cancelled", "cancelled", "Operation aborted");
  else if (text === "Tool execution was blocked") accept("blocked", "blocked", text);
  else if (/^Working directory does not exist: [^\n]+\nCannot execute (?:bash|powershell) commands\.$/.test(text)) accept("not_found", "ENOENT", "Working directory does not exist");
  else if (!shell || !text.includes("\n") || /^Validation failed for tool\b/.test(first)) {
    const fsCode = first.match(/^(ENOENT|ENOTDIR|EACCES|EPERM|ETIMEDOUT|EINVAL):/);
    if (fsCode) {
      const known = systemErrors[fsCode[1]!]!;
      const operation = first.match(/, (open|access|stat|lstat|scandir|spawn|read|write|rename|mkdir|unlink)\s/);
      accept(known.kind, fsCode[1]!, `${fsCode[1]}: ${known.summary}${operation ? `; operation=${operation[1]}` : ""}`);
    } else if (/^Tool [^\r\n]+ not found$/.test(text)) accept("not_found", "tool_not_found", "Tool not found");
    else if (/^Validation failed for tool\b/.test(first) || first === "Edit tool input is invalid. edits must contain at least one replacement." || /^Invalid timeout:/.test(first)) {
      accept("validation", "invalid_arguments", first.startsWith("Invalid timeout:") ? "Invalid timeout argument" : "Invalid tool arguments");
    } else if (/^Offset \d+ is beyond end of file \(\d+ lines total\)$/.test(text)) accept("validation", "invalid_arguments", "Read offset is beyond end of file");
  }
  return diagnostic;
}

interface ToolIdentity { toolCallId: string; toolName: string }
interface Start extends ToolIdentity { args?: unknown }
interface End extends ToolIdentity { result: unknown; isError: boolean }
interface Message extends ToolIdentity { role: "toolResult"; content: unknown; details?: unknown; isError: boolean }
interface Pending { context: DiagnosticFields; started: number; cancelled: boolean; timeoutMs?: number }
interface Options {
  enabled: () => boolean;
  capture: (cause: unknown, context: DiagnosticFields) => string | undefined;
  breadcrumb: (category: string, context: DiagnosticFields) => void;
  anonymize: (value: string) => string;
  now?: () => number;
}
const limit = 256;
function boundedSet<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key); map.set(key, value);
  if (map.size > limit) map.delete(map.keys().next().value!);
}

/** Each observer belongs to exactly one live session runtime. All instrumentation is best effort. */
export class ToolDiagnostics {
  private readonly options: Options;
  private readonly pending = new Map<string, Pending>();
  private readonly completed = new Map<string, true>();
  constructor(options: Options) { this.options = options; }
  private enabled(): boolean {
    if (this.options.enabled()) return true;
    this.clear(); return false;
  }
  private identity(event: ToolIdentity): ToolDiagnosticFields {
    return {
      toolName: builtinToolNames.has(event.toolName) ? event.toolName : "custom",
      ...(builtinToolNames.has(event.toolName) ? {} : { toolId: createHash("sha256").update(event.toolName).digest("hex").slice(0, 16) }),
      toolCallId: this.options.anonymize(`tool-call:${event.toolCallId}`),
    };
  }
  private breadcrumb(category: string, context: DiagnosticFields): void {
    try { this.options.breadcrumb(category, context); } catch { /* Isolate a failed telemetry sink. */ }
  }
  start(event: Start, context: DiagnosticFields = {}): void {
    try {
      if (!this.enabled() || this.pending.has(event.toolCallId) || this.completed.has(event.toolCallId)) return;
      const timeout = (event.toolName === "bash" || event.toolName === "powershell") ? object(event.args)?.timeout : undefined;
      const timeoutMs = typeof timeout === "number" && timeout > 0 && Number.isFinite(timeout * 1000) ? timeout * 1000 : undefined;
      const snapshot = { ...safeFields(context), ...this.identity(event), stage: "tool" };
      boundedSet(this.pending, event.toolCallId, { context: snapshot, started: (this.options.now ?? performance.now.bind(performance))(), cancelled: false, timeoutMs });
      this.breadcrumb("tool_start", snapshot);
    } catch { /* Instrumentation cannot affect the tool. */ }
  }
  end(event: End, context: DiagnosticFields = {}): void { this.finish(event, context, "tool_execution_end"); }
  message(message: Message, context: DiagnosticFields = {}): void {
    try {
      if (!this.enabled() || !message.isError) return;
      this.finish({ toolCallId: message.toolCallId, toolName: message.toolName, isError: message.isError, result: { content: message.content } }, context, "message_end");
    } catch { /* Do not inspect a disabled or malformed result. */ }
  }
  private finish(event: End, context: DiagnosticFields, source: "tool_execution_end" | "message_end"): void {
    try {
      if (!this.enabled() || this.completed.has(event.toolCallId)) return;
      const pending = this.pending.get(event.toolCallId);
      this.pending.delete(event.toolCallId); boundedSet(this.completed, event.toolCallId, true);
      const snapshot: DiagnosticFields = { ...(pending?.context ?? { ...safeFields(context), ...this.identity(event), stage: "tool" }), diagnosticSource: source };
      if (pending) {
        snapshot.durationMs = Math.max(0, Math.round((this.options.now ?? performance.now.bind(performance))() - pending.started));
        if (pending.timeoutMs !== undefined) snapshot.timeoutMs = pending.timeoutMs;
      }
      if (!event.isError) { this.breadcrumb("tool_end", snapshot); return; }
      const original = event.result instanceof Error ? event.result : object(event.result)?.error instanceof Error ? object(event.result)!.error as Error : undefined;
      const failure = pending?.cancelled && !original ? { failureKind: "cancelled", errorCode: "cancelled", level: "warning", originalStackAvailable: false, summaryOmitted: true, summaryOmittedReason: "cancelled" } : classifyToolFailure(event.result, event.toolName);
      Object.assign(snapshot, failure, { code: "tool_failed" });
      this.breadcrumb(failure.failureKind === "cancelled" ? "tool_cancelled" : failure.failureKind === "blocked" ? "tool_blocked" : "tool_failed", snapshot);
      if (failure.failureKind === "cancelled" || failure.failureKind === "blocked") return;
      let cause: Error;
      if (original) cause = diagnosticException(original, event.toolName);
      else { cause = new Error(`${snapshot.toolName}: ${failure.failureKind} (${failure.errorCode ?? "unknown"})`); cause.name = "ToolResultFailure"; cause.stack = undefined; }
      this.options.capture(cause, snapshot);
    } catch { /* Invalid SDK result shapes and failed sinks never change tool behavior. */ }
  }
  cancel(): void {
    try {
      if (!this.enabled()) return;
      for (const item of this.pending.values()) item.cancelled = true;
    } catch { /* Best effort. */ }
  }
  clear(): void { this.pending.clear(); this.completed.clear(); }
}

function diagnosticException(original: Error, toolName: string, depth = 0): Error {
  const diagnostic = classifyToolFailure(original, toolName);
  const error = new Error(diagnostic.errorSummary ?? "Tool exception (diagnostic text unavailable)");
  error.name = original.name;
  error.stack = original.stack ? `${error.name}: ${error.message}\n${original.stack.split("\n").slice(1).join("\n")}` : undefined;
  if (depth < 3 && original.cause instanceof Error) error.cause = diagnosticException(original.cause, toolName, depth + 1);
  return sanitizeError(error);
}
