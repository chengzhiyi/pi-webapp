import type { BaseTransportOptions, Breadcrumb, Client, Event, EventHint, StackFrame } from "@sentry/core";

export interface TelemetryConfig { enabled: boolean; dsn?: string; environment: string; release: string; buildId: string }
export interface ErrorCorrelation { errorId?: string; requestId?: string; operationId?: string }
export type DiagnosticFields = Record<string, unknown>;
export const privateDataCollection = { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false, genAI: { inputs: false, outputs: false }, graphQL: { document: false, variables: false }, databaseQueryData: false, queues: false, stackFrameVariables: false, frameContextLines: 0 } as const;
const fields = new Set(["stage", "route", "method", "status", "durationMs", "connection", "idle", "model", "thinkingLevel", "messageCount", "attachmentCount", "session", "requestId", "operationId", "errorId", "repeats", "dropped", "componentStack", "eventType", "sequence", "nodeVersion", "piVersion", "platform", "browser", "buildId", "code"]);
const routes = new Set([
  "/api/plugins", "/api/plugin-action", "/api/plugin-interaction", "/api/resume", "/api/update", "/api/update/version", "/api/provider/models", "/api/provider/logout", "/api/provider/login/active",
  "/api/telemetry/config", "/api/image", "/api/attachment", "/api/attachment/remove", "/api/session", "/api/providers", "/api/models", "/api/config", "/api/workspaces", "/api/commands", "/api/events", "/api/message", "/api/abort", "/api/compact", "/api/new-session", "/api/model", "/api/thinking-level",
  "/api/provider/login", "/api/provider/login/respond", "/api/provider/login/cancel", "/api/provider/custom", "/api/workspace/add", "/api/workspace/select", "/api/workspace/new-session", "/api/workspace/remove", "/api/session/select", "/api/directory/capability", "/api/directory/list", "/api/directory/create", "/api/directory/pick",
]);

/** These handlers may throw errors that contain conversations, plugin input or credentials. */
export function isContentOperation(route: string): boolean {
  return route === "/api/message" || route.startsWith("/api/provider/")
    || ["/api/plugin-action", "/api/plugin-interaction", "/api/resume", "/api/compact"].includes(route);
}

export function scrub(value: string): string {
  return value.slice(0, 8192)
    .replace(/(?:Bearer\s+\S+|(?:api[_-]?key|token|password|secret|authorization)\s*[=:]\s*\S+)/gi, "[redacted]")
    .replace(/\b(?:sk-|sntrys_|eyJ)[A-Za-z0-9_.-]+/g, "[redacted]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/https?:\/\/[^\s)]+/gi, "[url]")
    .replace(/(?:file:\/\/)?(?:\/[\w.~-]+){2,}(?::\d+(?::\d+)?)?/g, "[path]")
    .replace(/[A-Za-z]:\\[^\s)]+/g, "[path]")
    .replace(/(["'`])[^\n]*?\1/g, "[quoted]")
    .replace(/\{[^\n]*\}/g, "[object]")
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, "[redacted]")
    .slice(0, 1024);
}

export function safeFields(input: DiagnosticFields): DiagnosticFields {
  const output: DiagnosticFields = {};
  for (const key of fields) {
    const value = input[key];
    if (key === "route" && typeof value === "string") output[key] = routes.has(value.split("?")[0]!) ? value.split("?")[0] : "[route]";
    else if (typeof value === "string") output[key] = ["requestId", "operationId", "errorId", "session", "buildId"].includes(key) && /^[\w-]{1,80}$/.test(value) ? value : scrub(value);
    else if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) || value === null) output[key] = value;
  }
  return output;
}

/** Stable bundle/source locations without user directories, URL tokens or query strings. */
export function safeFilename(filename: string): string {
  const path = filename.replace(/\\/g, "/").split(/[?#]/)[0]!;
  if (path.startsWith("node:")) return path.slice(0, 150);
  const suffix = path.match(/(?:^|\/)((?:web\/src|extension|shared|dist|assets)\/[^\s:)]+)$/)?.[1]
    ?? path.split("/").pop() ?? "unknown";
  return `app:///${suffix.replace(/[^\w./-]/g, "_").slice(-200)}`;
}

export function sanitizeError(cause: unknown, depth = 0): Error {
  const original = cause instanceof Error ? cause : new Error(typeof cause === "string" ? cause : "Non-Error rejection");
  const error = new Error(scrub(original.message));
  error.name = scrub(original.name).slice(0, 100);
  if (original.stack) {
    const frames = original.stack.split("\n").slice(1, 31).map((line) => {
      // V8 locations retain line/column and the sanitized filename for source-map matching.
      const location = line.match(/((?:file:\/\/|https?:\/\/|\/|[A-Za-z]:\\)[^\s()]+):(\d+):(\d+)(\)?)$/);
      // Keep filenames locally until the SDK associates build debug IDs; beforeSend strips paths.
      if (location) return `${scrub(line.slice(0, location.index))}${location[1]}:${location[2]}:${location[3]}${location[4]}`;
      return scrub(line);
    });
    error.stack = `${error.name}: ${error.message}\n${frames.join("\n")}`;
  }
  if (depth < 3 && original.cause !== undefined) error.cause = sanitizeError(original.cause, depth + 1);
  return error;
}

export function opaqueError(cause: unknown, label: string): Error {
  const error = new Error(label);
  if (cause instanceof Error) {
    error.name = cause.name;
    if (cause.stack) error.stack = `${error.name}: ${label}\n${cause.stack.split("\n").slice(1).join("\n")}`;
  }
  return error;
}

function safeFrame(frame: StackFrame): StackFrame {
  return {
    ...(frame.filename ? { filename: safeFilename(frame.filename) } : {}),
    ...(frame.abs_path ? { abs_path: safeFilename(frame.abs_path) } : {}),
    ...(frame.function ? { function: scrub(frame.function) } : {}),
    lineno: frame.lineno, colno: frame.colno, in_app: frame.in_app,
  };
}

/** Rebuild rather than redact arbitrary SDK fields. No request/user/body/source context can escape. */
export function sanitizeEvent<T extends Event>(event: T): T {
  return {
    event_id: event.event_id, timestamp: event.timestamp, platform: event.platform, level: event.level,
    release: event.release, dist: event.dist, environment: scrub(event.environment ?? "production"),
    ...(event.message ? { message: scrub(event.message) } : {}),
    exception: event.exception ? { values: event.exception.values?.slice(0, 4).map((value) => ({
      type: scrub(value.type ?? "Error"), value: scrub(value.value ?? ""),
      ...(value.stacktrace ? { stacktrace: { frames: value.stacktrace.frames?.slice(-30).map(safeFrame) } } : {}),
      ...(value.mechanism ? { mechanism: { type: value.mechanism.type, handled: value.mechanism.handled } } : {}),
    })) } : undefined,
    tags: { side: event.tags?.side, buildId: event.tags?.buildId },
    contexts: { diagnostic: safeFields(event.contexts?.diagnostic ?? {}) },
    breadcrumbs: event.breadcrumbs?.slice(-100).map((item) => ({ timestamp: item.timestamp, category: scrub(item.category ?? "app"), data: safeFields(item.data ?? {}) })),
    debug_meta: event.debug_meta ? { images: event.debug_meta.images?.slice(0, 10).map((image) => ({
      type: image.type, debug_id: image.debug_id, ...(image.code_file ? { code_file: safeFilename(image.code_file) } : {}),
    })) } : undefined,
  } as unknown as T;
}

export function privateBeforeSend<T extends Event>(event: T, hint: EventHint): T {
  // Shared SDK scopes may contain host attachments; these live outside the event payload.
  hint.attachments = [];
  return sanitizeEvent(event);
}

export class BreadcrumbBuffer {
  private items: Array<{ item: Breadcrumb; size: number }> = [];
  private bytes = 0;
  private encoder = new TextEncoder();
  add(category: string, data: DiagnosticFields = {}): void {
    const item = { timestamp: Date.now() / 1000, category: scrub(category), data: safeFields(data) };
    const size = this.encoder.encode(JSON.stringify(item)).byteLength + 1;
    this.items.push({ item, size }); this.bytes += size;
    while (this.items.length > 100 || this.bytes > 64 * 1024 - 2) this.bytes -= this.items.shift()!.size;
  }
  snapshot(): Breadcrumb[] { return this.items.map(({ item }) => item); }
}

export class ErrorBudget {
  private windowAt = -1;
  private total = 0;
  private seen = new Map<string, { at: number; repeats: number }>();
  take(fingerprint: string, now = Date.now()): { repeats: number } | undefined {
    if (this.windowAt < 0 || now - this.windowAt >= 60_000) { this.windowAt = now; this.total = 0; }
    const previous = this.seen.get(fingerprint);
    if (previous && now - previous.at < 60_000) { previous.repeats++; return; }
    if (this.total >= 20) return;
    this.total++;
    if (this.seen.size >= 64 && !previous) this.seen.delete(this.seen.keys().next().value!);
    this.seen.set(fingerprint, { at: now, repeats: 0 });
    return { repeats: previous?.repeats ?? 0 };
  }
}

const expectedMessages = new Set([
  "会话已切换", "Pi 正在运行，请等待当前回复结束", "请等待当前回复结束", "请等待当前回复结束再切换工作区", "请等待当前回复结束再切换会话",
  "请先切换到其他工作区", "新会话已取消", "已有登录正在进行", "模型不可用", "模型提供方未配置认证", "当前模型不支持此推理强度",
  "其他提供方的登录正在进行，请先完成或取消当前登录", "当前会话没有暂停的任务", "请先完成当前交互或审批", "请先选择模型", "请先连接当前模型", "插件未启用", "会话运行实例已切换",
  "提供方已存在", "文件超过 20 MB", "请求内容过大", "会话不属于该工作区", "推理强度无效",
]);
export function isExpectedError(cause: unknown): boolean {
  return cause instanceof Error && (cause.name === "AbortError" || expectedMessages.has(cause.message));
}

export class ErrorReporter {
  private readonly budget = new ErrorBudget();
  readonly breadcrumbs: BreadcrumbBuffer;
  private readonly scopeClass: typeof import("@sentry/core").Scope;
  private readonly seen = new WeakSet<object>();
  private state: DiagnosticFields = {};
  private readonly client: Client;
  private readonly side: "browser" | "node";
  private readonly buildId: string;
  constructor(client: Client, side: "browser" | "node", buildId: string, sdk: Pick<typeof import("@sentry/core"), "Scope" | "linkedErrorsIntegration">, breadcrumbs = new BreadcrumbBuffer()) {
    this.client = client; this.side = side; this.buildId = buildId;
    this.scopeClass = sdk.Scope; this.breadcrumbs = breadcrumbs;
    client.addIntegration(sdk.linkedErrorsIntegration({ limit: 4 }));
  }
  setState(state: DiagnosticFields): void { this.state = safeFields(state); }
  capture(cause: unknown, context: DiagnosticFields = {}, eventId?: string): string | undefined {
    try {
      if (isExpectedError(cause)) return;
      if (typeof cause === "object" && cause !== null) {
        if (this.seen.has(cause)) return;
        this.seen.add(cause);
      }
      const error = sanitizeError(cause);
      const fingerprint = `${error.name}:${error.message}:${error.stack?.split("\n")[1] ?? ""}:${context.stage ?? ""}`;
      const allowed = this.budget.take(fingerprint);
      if (!allowed) return;
      const scope = new this.scopeClass();
      scope.setClient(this.client);
      scope.setTags({ side: this.side, buildId: this.buildId });
      scope.setContext("diagnostic", safeFields({ ...this.state, ...context, repeats: allowed.repeats }));
      for (const item of this.breadcrumbs.snapshot()) scope.addBreadcrumb(item, 100);
      return scope.captureException(error, eventId ? { event_id: eventId } : undefined);
    } catch { return; }
  }
  ignore(cause: object): void { this.seen.add(cause); }
}

export function boundedFetchTransport(createTransport: typeof import("@sentry/core").createTransport, options: BaseTransportOptions) {
  return createTransport({ ...options, bufferSize: 20 }, async ({ body }) => {
    const response = await fetch(options.url, {
      method: "POST", body: body as BodyInit, signal: AbortSignal.timeout(3000),
      credentials: "omit", referrerPolicy: "no-referrer", redirect: "error",
      headers: { "Content-Type": "application/x-sentry-envelope" },
    });
    return { statusCode: response.status, headers: { "x-sentry-rate-limits": response.headers.get("x-sentry-rate-limits"), "retry-after": response.headers.get("retry-after") } };
  });
}
