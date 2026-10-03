import { createAgentSession, createEventBus, DefaultResourceLoader, getAgentDir, SessionManager, type AgentSession, type EventBusController, type ExtensionContext, type SessionShutdownEvent, VERSION } from "@earendil-works/pi-coding-agent";
import { invokeWebAction, WebInteractionHost, PLUGIN_CHANGED, type ActionRequest } from "@chengzhiyi/pi-web-protocol";
import { realpath } from "node:fs/promises";
import { contentBlocks, projectEntry, projectPluginEntries, sessionTitle, sessionPaused, PAUSED_ENTRY, type SessionView, type ViewMessage } from "./view.ts";
import { WebPluginCatalog } from "./web-plugins.ts";
import { sessionsForWorkspace } from "./sessions-for-workspace.ts";
import { LifecycleQueue, closeAgentSession } from "./lifecycle.ts";
import { resumeMessage } from "./execution-control.ts";
import { pluginRuntimePaths } from "./plugin-runtime-paths.ts";
import type { BridgeEvent } from "./bridge.ts";
import { opaqueError, type DiagnosticFields, type ErrorCorrelation } from "../shared/telemetry.ts";
import { ToolDiagnostics } from "./tool-diagnostics.ts";

type HostEvent = BridgeEvent;
interface WorkspaceRuntime {
  session: AgentSession;
  cwd: string;
  catalog: WebPluginCatalog;
  bus: EventBusController;
  interactions: WebInteractionHost;
  detach: () => void;
  releasePaths: () => Promise<void>;
  generation: number;
  closing: boolean;
  waitController: AbortController;
  operation?: ErrorCorrelation;
  agentErrorReported?: boolean;
  tools: ToolDiagnostics;
}

export interface WorkspaceTelemetry {
  enabled(): boolean;
  breadcrumb(category: string, context: DiagnosticFields): void;
  anonymize(value: string): string;
}

/** One active SDK runtime; the host may retain it while the TUI is in front. */
export class WorkspaceSessions {
  readonly telemetryVersion = 2;
  private active: WorkspaceRuntime | null = null;
  private readonly queue = new LifecycleQueue();
  private generation = 0;
  private disposed = false;
  private readonly publish: (event: HostEvent) => void;
  private readonly fallbackModel: () => ExtensionContext["model"];
  private readonly isProjectTrusted: (cwd: string) => boolean;
  private readonly reportError: (cause: unknown, context: DiagnosticFields) => string | undefined;
  private readonly telemetry: WorkspaceTelemetry;

  constructor(publish: (event: HostEvent) => void, fallbackModel: () => ExtensionContext["model"], isProjectTrusted: (cwd: string) => boolean = () => false, reportError: (cause: unknown, context: DiagnosticFields) => string | undefined = () => undefined, telemetry: WorkspaceTelemetry = { enabled: () => false, breadcrumb: () => {}, anonymize: () => "unavailable" }) {
    this.publish = publish; this.fallbackModel = fallbackModel; this.isProjectTrusted = isProjectTrusted; this.reportError = reportError;
    this.telemetry = {
      enabled: () => { try { return telemetry.enabled(); } catch { return false; } },
      breadcrumb: (category, context) => { try { if (telemetry.enabled()) telemetry.breadcrumb(category, context); } catch { /* Failed instrumentation cannot break a session. */ } },
      anonymize: value => { try { return telemetry.enabled() ? telemetry.anonymize(value) : "unavailable"; } catch { return "unavailable"; } },
    };
  }
  get session(): AgentSession | null { return this.active?.session ?? null; }
  get path(): string | null { return this.active?.cwd ?? null; }
  get catalog(): WebPluginCatalog | null { return this.active?.catalog ?? null; }

  open(path: string, target: "continue" | "new" | { sessionFile: string } | { sessionManager: SessionManager }): Promise<void> {
    return this.queue.run(async () => {
      this.ensureAvailable();
      const canonical = await realpath(path);
      let manager: SessionManager;
      if (target === "new") manager = SessionManager.create(canonical);
      else if (target === "continue") {
        const recent = (await sessionsForWorkspace(canonical))[0];
        manager = recent ? SessionManager.open(recent.path) : SessionManager.create(canonical);
      } else manager = "sessionManager" in target ? target.sessionManager : SessionManager.open(target.sessionFile);
      if (await realpath(manager.getCwd()) !== canonical) throw new Error("会话不属于该工作区");
      await this.replace(canonical, manager, target === "new" ? "new" : "resume");
    });
  }

  /** Rebuild immutable extension paths and catalog while retaining session history. */
  reload(): Promise<void> {
    return this.queue.run(async () => {
      this.ensureAvailable();
      const current = this.active;
      if (!current) throw new Error("没有活动工作区会话");
      await this.replace(current.cwd, current.session.sessionManager, "reload");
    });
  }
  private ensureAvailable() {
    if (this.disposed) throw new Error("工作区服务已关闭");
    if (this.active && !this.active.session.isIdle) throw new Error("请等待当前回复结束再切换工作区");
  }
  private diagnostic(runtime: WorkspaceRuntime, pluginId: string, stage: string, message: string) {
    const detail = `plugin=${pluginId} session=${runtime.session.sessionManager.getSessionId()} generation=${runtime.generation} stage=${stage}: ${message}`;
    console.error(detail);
    if (!this.disposed) this.publish({ type: "error", message: detail });
  }
  private async replace(cwd: string, manager: SessionManager, reason: SessionShutdownEvent["reason"]): Promise<void> {
    const old = this.active;
    const catalog = await WebPluginCatalog.discover(cwd, this.isProjectTrusted(cwd));
    const bus = createEventBus();
    const runtimePaths = await pluginRuntimePaths(cwd, catalog.extensionRoots);
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir(), noExtensions: true, additionalExtensionPaths: runtimePaths.paths, eventBus: bus });
    let candidate: WorkspaceRuntime | null = null;
    try {
      await resourceLoader.reload();
      const loadErrors = resourceLoader.getExtensions().errors;
      if (loadErrors.length) throw new Error(loadErrors.map(item => `${item.path}: ${item.error}`).join("; "));
      const model = manager.buildSessionProjection().model ? undefined : old?.session.model ?? this.fallbackModel();
      const { session } = await createAgentSession({ cwd, sessionManager: manager, model, resourceLoader });
      const tools = new ToolDiagnostics({ enabled: () => this.telemetry.enabled(), capture: this.reportError, breadcrumb: (category, context) => this.telemetry.breadcrumb(category, context), anonymize: value => this.telemetry.anonymize(value) });
      const runtime: WorkspaceRuntime = { session, cwd, catalog, bus, generation: ++this.generation, closing: false, waitController: new AbortController(), interactions: null!, detach: () => {}, releasePaths: runtimePaths.release, tools };
      candidate = runtime;
      const publish = (event: HostEvent) => { if (!this.disposed && this.active === runtime && !runtime.closing) this.publish(event); };
      runtime.interactions = new WebInteractionHost(bus, request => !runtime.closing && request.sessionId === session.sessionManager.getSessionId() && catalog.has(request.pluginId), () => publish({ type: "snapshot", session: this.snapshotOf(runtime) }));
      let lastStreamAt = 0;
      const offChanged = bus.on(PLUGIN_CHANGED, () => publish({ type: "snapshot", session: this.snapshotOf(runtime) }));
      const offEvents = session.subscribe(event => {
        if (this.active === runtime && !runtime.closing) {
          const context: DiagnosticFields = { ...runtime.operation, session: this.telemetry.anonymize(session.sessionManager.getSessionId()), piVersion: VERSION, model: session.model ? `${session.model.provider}/${session.model.id}` : null, thinkingLevel: session.thinkingLevel };
          if (event.type === "agent_start") this.telemetry.breadcrumb("agent_start", context);
          if (event.type === "tool_execution_start") tools.start(event, context);
          if (event.type === "tool_execution_end") tools.end(event, context);
          if (event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "error") {
            runtime.agentErrorReported = true;
            const errorId = this.reportError(new Error("Agent response failed"), { ...runtime.operation, stage: "agent", code: "agent_failed", piVersion: VERSION });
            publish({ type: "error", message: event.message.errorMessage ?? "Agent response failed", errorCode: "unexpected_error", errorId, ...runtime.operation });
          }
          if (event.type === "message_end" && event.message.role === "toolResult") tools.message(event.message, context);
          if (event.type === "agent_settled") { this.telemetry.breadcrumb("agent_end", context); tools.clear(); runtime.operation = undefined; }
        }
        if (event.type === "message_update" && event.message.role === "assistant" && Date.now() - lastStreamAt >= 60) {
          lastStreamAt = Date.now();
          publish({ type: "stream", message: { id: "stream", role: "assistant", timestamp: new Date(event.message.timestamp).toISOString(), blocks: contentBlocks(event.message.content) } });
        }
        if (["message_end", "agent_start", "agent_settled", "session_info_changed", "entry_appended"].includes(event.type)) {
          if (event.type === "message_end" && event.message.role === "assistant") publish({ type: "stream", message: null });
          publish({ type: "snapshot", session: this.snapshotOf(runtime) });
        }
      });
      runtime.detach = () => { offChanged(); offEvents(); };
      const startupErrors: string[] = [];
      let initializing = true;
      await session.bindExtensions({ mode: "print", shutdownHandler: () => {}, onError: error => {
        if (initializing) startupErrors.push(error.error);
        this.diagnostic(runtime, catalog.plugins.find(plugin => error.extensionPath.startsWith(plugin.root + "/"))?.id ?? error.extensionPath, error.event ?? "runtime", error.error);
      } });
      initializing = false;
      if (startupErrors.length) throw new Error(startupErrors.join("; "));
      this.ensureAvailable();
      if (old) await this.close(old, reason);
      if (this.disposed) throw new Error("工作区服务已关闭");
      this.active = runtime;
      candidate = null;
      this.publish({ type: "stream", message: null });
      this.publish({ type: "snapshot", session: this.snapshot() });
    } catch (error) {
      if (candidate) await this.close(candidate, "quit"); else { bus.clear(); await runtimePaths.release(); }
      throw error;
    }
  }
  private async close(runtime: WorkspaceRuntime, reason: SessionShutdownEvent["reason"]): Promise<void> {
    if (runtime.closing) return;
    runtime.closing = true;
    runtime.tools.clear();
    runtime.waitController.abort();
    runtime.interactions.dispose();
    await closeAgentSession(runtime.session, reason, message => this.diagnostic(runtime, "host", "shutdown", message), 5_000, () => { runtime.detach(); runtime.bus.clear(); });
    await runtime.releasePaths();
  }
  private snapshotOf(runtime: WorkspaceRuntime): SessionView {
    const { session, cwd, catalog } = runtime;
    const messages = session.sessionManager.getBranch().flatMap(entry => { const message = projectEntry(entry); return message ? [message] : []; });
    return {
      schemaVersion: 1, sessionId: session.sessionManager.getSessionId(), cwd,
      name: sessionTitle(session.sessionManager.getSessionName(), messages),
      model: session.model ? `${session.model.provider}/${session.model.id}` : null,
      thinkingLevel: session.thinkingLevel, thinkingLevels: session.getAvailableThinkingLevels(), idle: session.isIdle,
      paused: sessionPaused(session.sessionManager.getBranch()),
      contextUsage: session.getContextUsage() ?? null, messages,
      interactions: runtime.interactions.pending(session.sessionManager.getSessionId()),
      pluginEntries: projectPluginEntries(session.sessionManager.getBranch(), catalog.ids()),
    };
  }
  snapshot(): SessionView {
    if (!this.active) throw new Error("没有活动工作区会话");
    return this.snapshotOf(this.active);
  }
  async invokePluginAction(request: ActionRequest): Promise<unknown> {
    const runtime = this.active;
    if (this.disposed || !runtime || runtime.closing || request.sessionId !== runtime.session.sessionManager.getSessionId()) throw new Error("会话已切换");
    if (!runtime.catalog.has(request.pluginId)) throw new Error("插件未启用");
    const runner = runtime.session.extensionRunner;
    const value = await invokeWebAction(runtime.bus, request, 15_000, runtime.waitController.signal);
    if (this.active !== runtime || runtime.closing || runner !== runtime.session.extensionRunner) throw new Error("会话运行实例已切换");
    this.publish({ type: "snapshot", session: this.snapshot() });
    return value;
  }
  resolveInteraction(sessionId: string, pluginId: string, requestId: string, value: unknown): void {
    if (this.disposed || !this.active || this.active.closing) throw new Error("Interaction host unavailable");
    this.active.interactions.resolve(sessionId, pluginId, requestId, value);
  }

  async send(text: string, images: Array<{ type: "image"; data: string; mimeType: string }> = [], correlation?: ErrorCorrelation): Promise<void> {
    if (this.disposed || !this.session || !this.session.isIdle) throw new Error("Pi 正在运行，请等待当前回复结束");
    // Acknowledge after Pi validates the model and credentials, while the
    // model response continues through the session event stream.
    const active = this.session;
    const runtime = this.active!;
    runtime.operation = correlation;
    this.telemetry.breadcrumb("send", { ...correlation, piVersion: VERSION });
    runtime.agentErrorReported = false;
    let accepted = false;
    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    const preflight = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    void active.prompt(text, { images, preflightResult: (ok) => {
      if (ok) { accepted = true; resolve(); }
    } }).then(() => { if (!accepted) resolve(); }).catch((cause: unknown) => {
      if (!accepted) reject(cause);
      else if (this.active === runtime && !runtime.closing && !runtime.agentErrorReported) {
        const errorId = this.reportError(opaqueError(cause, "Agent response failed"), { ...correlation, stage: "agent", code: "agent_failed", piVersion: VERSION });
        this.publish({ type: "error", message: cause instanceof Error ? cause.message : "Pi 请求失败", errorCode: "unexpected_error", errorId, ...correlation });
      }
    });
    try { await preflight; } catch (cause) { runtime.operation = undefined; throw cause; }
  }

  async stop(): Promise<void> {
    const runtime = this.active;
    if (!runtime || runtime.session.isIdle) return;
    runtime.tools.cancel();
    this.telemetry.breadcrumb("cancel", { ...runtime.operation });
    runtime.session.sessionManager.appendCustomEntry(PAUSED_ENTRY);
    await runtime.session.abort();
    if (this.active === runtime && !runtime.closing) this.publish({ type: 'snapshot', session: this.snapshotOf(runtime) });
  }

  async resume(correlation?: ErrorCorrelation): Promise<void> {
    const runtime = this.active;
    if (this.disposed || !runtime || runtime.closing) throw new Error('Pi 会话不可用');
    const session = runtime.session;
    if (!session.isIdle) throw new Error('Pi 正在运行，请等待当前回复结束');
    if (!sessionPaused(session.sessionManager.getBranch())) throw new Error('当前会话没有暂停的任务');
    if (!session.model) throw new Error('请先选择模型');
    const authenticated = session.modelRuntime.hasConfiguredAuth(session.model.provider)
      || await session.modelRuntime.checkAuth(session.model.provider) !== undefined;
    if (!authenticated) throw new Error('请先连接当前模型');
    if (this.active !== runtime || runtime.closing) throw new Error('会话已切换');
    if (!session.isIdle) throw new Error('Pi 正在运行，请等待当前回复结束');
    if (!sessionPaused(session.sessionManager.getBranch())) throw new Error('当前会话没有暂停的任务');
    const message = resumeMessage(this.snapshotOf(runtime).messages);
    runtime.operation = correlation;
    runtime.agentErrorReported = false;
    this.telemetry.breadcrumb("resume", { ...correlation });
    void session.sendCustomMessage(message, { triggerTurn: true }).catch(cause => {
      if (this.active === runtime && !runtime.closing && !runtime.agentErrorReported) {
        const errorId = this.reportError(opaqueError(cause, "Agent resume failed"), { ...correlation, stage: "agent", code: "agent_failed" });
        this.publish({ type: 'error', message: cause instanceof Error ? cause.message : '继续失败', errorId, ...correlation });
      }
    });
  }

  async models(): Promise<Array<{ provider: string; id: string; name: string }>> {
    const available = await this.session?.modelRuntime.getAvailable() ?? [];
    return available.map((model) => ({ provider: model.provider, id: model.id, name: model.name }));
  }

  async setModel(provider: string, id: string): Promise<void> {
    if (this.disposed || !this.session || !this.session.isIdle) throw new Error("Pi 正在运行，请等待当前回复结束");
    const model = this.session.modelRuntime.getModel(provider, id);
    if (!model) throw new Error("模型不可用");
    await this.session.setModel(model);
    this.publish({ type: "snapshot", session: this.snapshot() });
  }

  dispose(): Promise<void> {
    this.disposed = true;
    // disposed stops publication immediately, before queued cleanup starts.
    return this.queue.run(async () => {
      const runtime = this.active;
      this.active = null;
      if (runtime) await this.close(runtime, "quit");
    });
  }
}
