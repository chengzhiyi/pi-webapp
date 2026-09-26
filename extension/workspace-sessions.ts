import { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager, type AgentSession, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { realpath } from "node:fs/promises";
import { contentBlocks, projectEntry, sessionTitle, type SessionView, type ViewMessage } from "./view.ts";
import { sessionsForWorkspace } from "./sessions-for-workspace.ts";

/** Pi SDK session for a workspace other than the attached TUI session. */
export class WorkspaceSessions {
  private active: AgentSession | null = null;
  private detach: (() => void) | null = null;
  private cwd: string | null = null;
  private lastStreamAt = 0;
  private readonly publish: (event: { type: "snapshot"; session: SessionView } | { type: "stream"; message: ViewMessage | null } | { type: "error"; message: string }) => void;
  private readonly fallbackModel: () => ExtensionContext["model"];

  constructor(publish: (event: { type: "snapshot"; session: SessionView } | { type: "stream"; message: ViewMessage | null } | { type: "error"; message: string }) => void, fallbackModel: () => ExtensionContext["model"]) {
    this.publish = publish;
    this.fallbackModel = fallbackModel;
  }

  get session(): AgentSession | null { return this.active; }
  get path(): string | null { return this.cwd; }

  async open(path: string, target: "continue" | "new" | { sessionFile: string }): Promise<void> {
    if (this.active && !this.active.isIdle) throw new Error("请等待当前回复结束再切换工作区");
    const canonical = await realpath(path);
    let manager: SessionManager;
    if (target === "new") manager = SessionManager.create(canonical);
    else if (target === "continue") {
      const recent = (await sessionsForWorkspace(canonical))[0];
      manager = recent ? SessionManager.open(recent.path) : SessionManager.create(canonical);
    } else manager = SessionManager.open(target.sessionFile);
    if (await realpath(manager.getCwd()) !== canonical) throw new Error("会话不属于该工作区");
    const model = manager.buildSessionProjection().model ? undefined : this.active?.model ?? this.fallbackModel();
    // A nested SDK session must not load pi-web again: its extension holds the
    // outer TUI bridge in process-global state. Skills/context still load.
    const resourceLoader = new DefaultResourceLoader({ cwd: canonical, agentDir: getAgentDir(), noExtensions: true });
    await resourceLoader.reload();
    const { session } = await createAgentSession({ cwd: canonical, sessionManager: manager, model, resourceLoader });
    this.detach?.();
    this.active?.dispose();
    this.active = session;
    this.cwd = canonical;
    this.detach = session.subscribe((event) => {
      if (event.type === "message_update" && event.message.role === "assistant") {
        const now = Date.now();
        if (now - this.lastStreamAt >= 60) {
          this.lastStreamAt = now;
          this.publish({ type: "stream", message: { id: "stream", role: "assistant", timestamp: new Date(event.message.timestamp).toISOString(), blocks: contentBlocks(event.message.content) } });
        }
      }
      if (event.type === "message_end" || event.type === "agent_start" || event.type === "agent_settled" || event.type === "session_info_changed") {
        if (event.type === "message_end" && event.message.role === "assistant") this.publish({ type: "stream", message: null });
        this.publish({ type: "snapshot", session: this.snapshot() });
      }
    });
    this.publish({ type: "stream", message: null });
    this.publish({ type: "snapshot", session: this.snapshot() });
  }

  snapshot(): SessionView {
    const session = this.active;
    if (!session || !this.cwd) throw new Error("没有活动工作区会话");
    const messages = session.sessionManager.getBranch().flatMap((entry) => {
      const message = projectEntry(entry);
      return message ? [message] : [];
    });
    return {
      schemaVersion: 1,
      sessionId: session.sessionManager.getSessionId(),
      cwd: this.cwd,
      name: sessionTitle(session.sessionManager.getSessionName(), messages),
      model: session.model ? `${session.model.provider}/${session.model.id}` : null,
      thinkingLevel: session.thinkingLevel,
      thinkingLevels: session.getAvailableThinkingLevels(),
      idle: session.isIdle,
      contextUsage: session.getContextUsage() ?? null,
      messages,
    };
  }

  async send(text: string, images: Array<{ type: "image"; data: string; mimeType: string }> = []): Promise<void> {
    if (!this.active || !this.active.isIdle) throw new Error("Pi 正在运行，请等待当前回复结束");
    // Acknowledge after Pi validates the model and credentials, while the
    // model response continues through the session event stream.
    const active = this.active;
    let accepted = false;
    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    const preflight = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    void active.prompt(text, { images, preflightResult: (ok) => {
      if (ok) { accepted = true; resolve(); }
    } }).then(() => { if (!accepted) resolve(); }).catch((cause: unknown) => {
      if (!accepted) reject(cause);
      else this.publish({ type: "error", message: cause instanceof Error ? cause.message : "Pi 请求失败" });
    });
    await preflight;
  }

  async stop(): Promise<void> { await this.active?.abort(); }

  async models(): Promise<Array<{ provider: string; id: string; name: string }>> {
    const available = await this.active?.modelRuntime.getAvailable() ?? [];
    return available.map((model) => ({ provider: model.provider, id: model.id, name: model.name }));
  }

  async setModel(provider: string, id: string): Promise<void> {
    if (!this.active || !this.active.isIdle) throw new Error("Pi 正在运行，请等待当前回复结束");
    const model = this.active.modelRuntime.getModel(provider, id);
    if (!model) throw new Error("模型不可用");
    await this.active.setModel(model);
    this.publish({ type: "snapshot", session: this.snapshot() });
  }

  dispose(): void {
    this.detach?.();
    this.active?.dispose();
    this.detach = null;
    this.active = null;
    this.cwd = null;
  }
}
