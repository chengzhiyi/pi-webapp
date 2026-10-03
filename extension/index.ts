import { delimiter, dirname, join, resolve } from "node:path";
import { realpathSync, watch, type FSWatcher } from "node:fs";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DefaultPackageManager, getAgentDir, ModelRuntime, SessionManager, SettingsManager, VERSION } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels, type AuthInteraction } from "@earendil-works/pi-ai";
import { startBridge, type Bridge, type BridgeHost, type ConfigChange, type ConfigView, type WorkspaceListView, type WorkspaceSessionView } from "./bridge.ts";
import { contentBlocks, projectSession, PAUSED_ENTRY } from "./view.ts";
import { WorkspaceRegistry, workspaceRegistryPath } from "./workspaces.ts";
import { WorkspaceSessions } from "./workspace-sessions.ts";
import { sessionsForWorkspace } from "./sessions-for-workspace.ts";
import { buildResourceInventory } from "./config-inventory.ts";
import { preferBrowserLogin, type LoginMethod } from "./provider-login.ts";
import { addCustomProvider, type CustomProviderInput } from "./custom-provider.ts";
import { getProviderModels, updateProviderModel, type ModelChange } from "./provider-model-config.ts";
import { openWebPage } from "./open-web-page.ts";
import { SelfUpdater } from "./self-update.ts";
import { randomUUID } from "node:crypto";
import { invokeWebAction, WebInteractionHost, PLUGIN_CHANGED } from "@chengzhiyi/pi-web-protocol";
import { WebPluginCatalog } from "./web-plugins.ts";
import { LifecycleQueue } from "./lifecycle.ts";
import { resumeMessage } from "./execution-control.ts";
import type { ErrorCorrelation } from "../shared/telemetry.ts";
import { NodeTelemetry } from "./telemetry.ts";
import { buildId } from "../shared/build-info.ts";
import { ToolDiagnostics } from "./tool-diagnostics.ts";
export { verifySentryNodeRelease } from "./sentry-verification.ts";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../web/dist");
// Keep reload state for this copy; an installed older copy must not close it.
const stateKey = Symbol.for(`pi-web.bridge-state:${import.meta.url}`);

interface SharedState {
  bridge: Bridge | null;
  current: ExtensionContext | null;
  commandContext: ExtensionCommandContext | null;
  pi: ExtensionAPI | null;
  replacementContext: ExtensionCommandContext & { sendUserMessage(content: string | Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>, options?: { expandPromptTemplates?: boolean }): Promise<void> } | null;
  replacementSessionId: string | null;
  lastStreamAt: number;
  workspaces: WorkspaceRegistry | null;
  workspaceSessions: WorkspaceSessions | null;
  selected: "tui" | "sdk";
  activeWorkspaceId: string | null;
  operation?: ErrorCorrelation;
  telemetry?: NodeTelemetry | null;
  autoOpened: boolean;
  tuiCatalog: WebPluginCatalog | null;
  stopPluginWatch: (() => void) | null;
  interactions: WebInteractionHost | null;
  lifecycle: LifecycleQueue;
  tuiGeneration: number;
  stopChanged: (() => void) | null;
  tuiWaitController: AbortController;
  tools?: ToolDiagnostics;
}

const shared = ((globalThis as Record<symbol, SharedState>)[stateKey] ??= {
  bridge: null,
  current: null,
  commandContext: null,
  pi: null,
  replacementContext: null,
  replacementSessionId: null,
  lastStreamAt: 0,
  workspaces: null,
  workspaceSessions: null,
  selected: "tui",
  activeWorkspaceId: null,
  autoOpened: false,
  tuiCatalog: null,
  stopPluginWatch: null,
  interactions: null,
  lifecycle: new LifecycleQueue(),
  tuiGeneration: 0,
  stopChanged: null,
  tuiWaitController: new AbortController(),
});
// Initialize fields when a development reload retained an older bridge state.
shared.lifecycle ??= new LifecycleQueue();
shared.tuiGeneration ??= 0;
shared.stopChanged ??= null;
shared.tuiWaitController ??= new AbortController();
function activeCatalog(): WebPluginCatalog | null {
  return shared.selected === "sdk" ? shared.workspaceSessions?.catalog ?? null : shared.tuiCatalog;
}
let authRuntime: Promise<ModelRuntime> | null = null;
function modelAuthRuntime() { return authRuntime ??= ModelRuntime.create({ refreshOnCreate: false }); }
const mirroredProviders = new Map<string, object>();
async function currentProviderRuntime(): Promise<ModelRuntime> {
  const runtime = await modelAuthRuntime();
  const registry = shared.selected === "tui" ? shared.current?.modelRegistry : undefined;
  const ids = new Set(registry?.getRegisteredProviderIds() ?? []);
  for (const id of mirroredProviders.keys()) if (!ids.has(id)) { runtime.unregisterProvider(id); mirroredProviders.delete(id); }
  for (const id of ids) {
    const native = registry?.getRegisteredNativeProvider(id);
    const legacy = registry?.getRegisteredProviderConfig(id);
    const registration = native ?? legacy;
    if (!registration || mirroredProviders.get(id) === registration) continue;
    if (native) runtime.registerNativeProvider(native);
    else if (legacy) runtime.registerProvider(id, legacy);
    mirroredProviders.set(id, registration);
  }
  await runtime.refresh({ allowNetwork: false });
  return runtime;
}

function snapshot() {
  if (shared.selected === "sdk") return shared.workspaceSessions?.snapshot() ?? (() => { throw new Error("没有活动会话"); })();
  if (shared.current === null) throw new Error("没有活动会话");
  return { ...projectSession(shared.current, shared.current.sessionManager.getSessionName(), activeCatalog()?.ids() ?? []), interactions: shared.interactions?.pending(shared.current.sessionManager.getSessionId()) ?? [] };
}

function activeSession(sessionId: string) {
  if (snapshot().sessionId !== sessionId) throw new Error("会话已切换");
}

async function workspaceList(): Promise<WorkspaceListView> {
  const items = shared.workspaces?.list() ?? [];
  const active = snapshot();
  const activePath = await realpath(active.cwd).catch((cause) => { shared.bridge?.reportError?.(cause, { stage: "workspace_path" }); return active.cwd; });
  const allSessions = await SessionManager.listAll();
  const sessions: WorkspaceSessionView[] = (await Promise.all(items.map(async (workspace) => {
    const saved = await sessionsForWorkspace(workspace.path, allSessions).catch((cause) => { shared.bridge?.reportError?.(cause, { stage: "workspace_sessions" }); return []; });
    const rows: WorkspaceSessionView[] = saved.map((session) => ({ id: session.id, workspaceId: workspace.id, path: session.path, name: session.name || session.firstMessage?.slice(0, 50) || "当前会话", modified: session.modified.toISOString() }));
    if (workspace.path === activePath && !rows.some((session) => session.id === active.sessionId)) {
      rows.unshift({ id: active.sessionId, workspaceId: workspace.id, path: null, name: active.name, modified: new Date().toISOString() });
    }
    return rows;
  }))).flat();
  return { items, activeId: shared.activeWorkspaceId, sessions };
}

async function publishWorkspaces(): Promise<void> {
  try { if (shared.bridge) shared.bridge.publish({ type: "workspaces", value: await workspaceList() }); }
  catch (cause) { shared.bridge?.reportError?.(cause, { stage: "workspace_list" }); }
}

async function selectWorkspace(id: string, fresh = false): Promise<void> {
  const workspace = shared.workspaces?.get(id);
  if (!workspace) throw new Error("工作区不存在");
  await realpath(workspace.path);
  if (!fresh && shared.current && workspace.path === await realpath(shared.current.cwd)) {
    if (shared.selected === "sdk" && shared.workspaceSessions?.session && !shared.workspaceSessions.session.isIdle) throw new Error("请等待当前回复结束再切换工作区");
    shared.selected = "tui";
    shared.activeWorkspaceId = id;
    shared.bridge?.publish({ type: "stream", message: null });
    shared.bridge?.publish({ type: "snapshot", session: snapshot() });
  } else {
    if (!shared.workspaceSessions) throw new Error("Pi 工作区服务不可用");
    await shared.workspaceSessions.open(workspace.path, fresh ? "new" : "continue");
    shared.selected = "sdk";
    shared.activeWorkspaceId = id;
    shared.bridge?.publish({ type: "snapshot", session: snapshot() });
  }
  await publishWorkspaces();
}

function sameSession(sessionId: string): ExtensionContext {
  const current = shared.current;
  if (current === null || current.sessionManager.getSessionId() !== sessionId) throw new Error("会话已切换");
  return current;
}

function publishSnapshot(ctx: ExtensionContext): void {
  shared.current = ctx;
  if (shared.selected === "tui") shared.bridge?.publish({ type: "snapshot", session: snapshot() });
}

function settingsForCurrent() {
  if (shared.current === null) throw new Error("没有活动会话");
  const cwd = shared.selected === "sdk" ? shared.workspaceSessions?.path : shared.current.cwd;
  if (!cwd) throw new Error("没有活动工作区");
  const projectTrusted = shared.selected === "tui" ? shared.current.isProjectTrusted() : shared.workspaceSessions?.session?.settingsManager.isProjectTrusted() ?? false;
  return SettingsManager.create(cwd, undefined, { projectTrusted });
}

async function configView(): Promise<ConfigView> {
  const settings = settingsForCurrent();
  const pick = (value: { packages?: Array<string | { source: string }>; extensions?: string[]; skills?: string[] }) => ({
    packages: (value.packages ?? []).map((entry) => typeof entry === "string" ? entry : entry.source),
    extensions: value.extensions ?? [],
    skills: value.skills ?? [],
  });
  const manager = new DefaultPackageManager({ cwd: snapshot().cwd, agentDir: getAgentDir(), settingsManager: settings });
  const installed = buildResourceInventory(manager.listConfiguredPackages(), await manager.resolve(async () => "skip"));
  return { projectTrusted: settings.isProjectTrusted(), global: pick(settings.getGlobalSettings()), project: pick(settings.getProjectSettings()), installed };
}

async function changeConfig(change: ConfigChange): Promise<ConfigView> {
  activeSession(change.sessionId);
  const active = shared.selected === "tui" ? sameSession(change.sessionId) : null;
  if (active ? !active.isIdle() : !shared.workspaceSessions?.session?.isIdle) throw new Error("Pi 正在运行，请等待当前回复结束");
  const settings = settingsForCurrent();
  if (change.scope === "project" && !settings.isProjectTrusted()) throw new Error("当前项目尚未受信任，无法修改项目设置");
  const value = change.value.trim();
  const current = change.scope === "project" ? settings.getProjectSettings() : settings.getGlobalSettings();
  if (change.kind === "packages") {
    const manager = new DefaultPackageManager({ cwd: snapshot().cwd, agentDir: getAgentDir(), settingsManager: settings });
    if (change.action === "add") await manager.installAndPersist(value, { local: change.scope === "project" });
    else await manager.removeAndPersist(value, { local: change.scope === "project" });
  } else if (change.kind === "extensions") {
    const original = current.extensions ?? [];
    const next = change.action === "add" ? [...new Set([...original, value])] : original.filter((entry) => entry !== value);
    if (change.scope === "project") settings.setProjectExtensionPaths(next); else settings.setExtensionPaths(next);
  } else {
    const original = current.skills ?? [];
    const next = change.action === "add" ? [...new Set([...original, value])] : original.filter((entry) => entry !== value);
    if (change.scope === "project") settings.setProjectSkillPaths(next); else settings.setSkillPaths(next);
  }
  await settings.flush();
  if (shared.selected === "tui") {
    if (shared.commandContext) await shared.commandContext.reload();
    if (shared.current) publishSnapshot(shared.current);
  } else {
    await shared.workspaceSessions?.reload();
    shared.bridge?.publish({ type: "plugins_changed" });
  }
  return await configView();
}

export default function piWeb(pi: ExtensionAPI, openPage: (url: string) => Promise<boolean> = openWebPage): void {
  shared.pi = pi;
  shared.tools?.clear();
  shared.tools = new ToolDiagnostics({
    enabled: () => !!shared.telemetry?.enabled && !!shared.bridge,
    capture: (cause, context) => shared.bridge?.reportError?.(cause, context),
    breadcrumb: (category, context) => shared.bridge?.breadcrumb?.(category, context),
    anonymize: value => shared.telemetry?.session(value) ?? "unavailable",
  });
  const diagnosticContext = (ctx: ExtensionContext): Record<string, unknown> => ({ ...shared.operation, session: shared.telemetry?.session(ctx.sessionManager.getSessionId()), piVersion: VERSION, model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null, thinkingLevel: ctx.thinkingLevel });
  shared.interactions?.dispose();
  shared.interactions = new WebInteractionHost(pi.events, (request) => !!shared.bridge && shared.selected === "tui" && request.sessionId === shared.current?.sessionManager.getSessionId() && !!shared.tuiCatalog?.has(request.pluginId), () => { if (shared.current && shared.selected === "tui") publishSnapshot(shared.current); });
  const bindChanged = () => {
    shared.stopChanged?.();
    shared.stopChanged = pi.events.on(PLUGIN_CHANGED, () => {
      if (shared.selected === "tui" && shared.current) publishSnapshot(shared.current);
    });
  };
  bindChanged();

  pi.on("session_start", async (_event, ctx) => {
    shared.tools?.clear();
    shared.operation = undefined;
    shared.tuiWaitController.abort();
    shared.tuiWaitController = new AbortController();
    shared.tuiGeneration++;
    bindChanged();
    shared.current = ctx;
    if (shared.bridge) {
      const catalog = await WebPluginCatalog.discover(ctx.cwd, ctx.isProjectTrusted?.() ?? false);
      if (shared.current !== ctx) return;
      shared.tuiCatalog = catalog;
    }
    if (shared.replacementSessionId !== ctx.sessionManager.getSessionId()) {
      shared.replacementContext = null;
      shared.replacementSessionId = null;
    }
    publishSnapshot(ctx);
    if (shared.bridge) shared.bridge.publish({ type: "plugins_changed" });
    if (shared.selected === "tui" && shared.workspaces) {
      void shared.workspaces.add(ctx.cwd).then(async (workspace) => {
        if (shared.selected !== "tui" || shared.current?.sessionManager.getSessionId() !== ctx.sessionManager.getSessionId()) return;
        shared.activeWorkspaceId = workspace.id;
        await publishWorkspaces();
      }).catch((error: unknown) => {
        shared.bridge?.publish({ type: "error", message: error instanceof Error ? error.message : "无法注册当前工作区", errorCode: "unexpected_error", errorId: shared.bridge.reportError?.(error, { stage: "workspace_register" }) });
      });
    }
    if (process.env.PI_WEBAPP_AUTO_OPEN === "1" && ctx.mode === "tui" && !shared.autoOpened) {
      shared.autoOpened = true;
      void openWeb(ctx).catch((error: unknown) => {
        ctx.ui.notify(error instanceof Error ? error.message : "Web 启动失败", "error");
      });
    }
  });
  pi.on("agent_start", (_event, ctx) => { if (shared.selected === "tui") shared.bridge?.breadcrumb?.("agent_start", diagnosticContext(ctx)); publishSnapshot(ctx); });
  pi.on("agent_end", (_event, ctx) => publishSnapshot(ctx));
  pi.on("agent_settled", (_event, ctx) => { if (shared.selected === "tui") { shared.bridge?.breadcrumb?.("agent_end", diagnosticContext(ctx)); shared.tools?.clear(); shared.operation = undefined; } publishSnapshot(ctx); });
  pi.on("tool_execution_start", (event, ctx) => { if (shared.selected === "tui") shared.tools?.start(event, diagnosticContext(ctx)); });
  pi.on("tool_execution_end", (event, ctx) => { if (shared.selected === "tui") shared.tools?.end(event, diagnosticContext(ctx)); });
  pi.on("model_select", (_event, ctx) => publishSnapshot(ctx));
  pi.on("thinking_level_select", (_event, ctx) => publishSnapshot(ctx));
  pi.on("message_end", (event, ctx) => {
    if (shared.selected === "tui" && event.message.role === "assistant" && event.message.stopReason === "error") {
      const errorId = shared.bridge?.reportError?.(new Error("Agent response failed"), { ...shared.operation, stage: "agent", code: "agent_failed", piVersion: VERSION });
      shared.bridge?.publish({ type: "error", message: event.message.errorMessage ?? "Agent response failed", errorCode: "unexpected_error", errorId, ...shared.operation });
    }
    if (shared.selected === "tui" && event.message.role === "toolResult") shared.tools?.message(event.message, diagnosticContext(ctx));
    if (shared.selected === "tui" && event.message.role === "assistant") shared.bridge?.publish({ type: "stream", message: null });
    publishSnapshot(ctx);
    if (shared.selected === "tui") void publishWorkspaces();
  });
  pi.on("session_info_changed", (_event, ctx) => publishSnapshot(ctx));
  pi.on("message_update", (event, ctx) => {
    shared.current = ctx;
    if (shared.selected !== "tui" || event.message.role !== "assistant" || shared.bridge === null) return;
    const now = Date.now();
    if (now - shared.lastStreamAt < 60) return;
    shared.lastStreamAt = now;
    shared.bridge.publish({
      type: "stream",
      message: {
        id: "stream",
        role: "assistant",
        timestamp: new Date(event.message.timestamp).toISOString(),
        blocks: contentBlocks(event.message.content),
      },
    });
  });
  pi.on("session_shutdown", async (event) => {
    shared.tools?.clear();
    shared.operation = undefined;
    shared.tuiWaitController.abort();
    shared.tuiGeneration++;
    shared.stopChanged?.();
    shared.stopChanged = null;
    shared.interactions?.cancelAll();
    shared.current = null;
    if (event.reason === "new" || event.reason === "resume" || event.reason === "fork" || event.reason === "reload") return;
    const bridge = shared.bridge;
    const telemetry = shared.telemetry;
    shared.bridge = null;
    shared.commandContext = null;
    shared.replacementContext = null;
    shared.replacementSessionId = null;
    shared.pi = null;
    const workspaceSessions = shared.workspaceSessions;
    shared.workspaceSessions = null;
    await workspaceSessions?.dispose();
    shared.selected = "tui";
    shared.activeWorkspaceId = null;
    shared.autoOpened = false;
    shared.tuiCatalog = null;
    shared.stopPluginWatch?.();
    shared.stopPluginWatch = null;
    shared.operation = undefined;
    shared.telemetry = null;
    if (bridge) await bridge.close();
    else await telemetry?.close();
  });

  const openWeb = async (ctx: ExtensionContext | ExtensionCommandContext): Promise<void> => {
      shared.telemetry ??= new NodeTelemetry();
      try {
        shared.current = ctx;
        shared.commandContext = "newSession" in ctx ? ctx : null;
        shared.pi = pi;
        shared.tuiCatalog = await WebPluginCatalog.discover(ctx.cwd, ctx.isProjectTrusted?.() ?? false);
        if (shared.workspaces === null) {
          shared.workspaces = new WorkspaceRegistry(workspaceRegistryPath(getAgentDir()));
          await shared.workspaces.load();
        }
        try {
          await shared.workspaces.discover((await SessionManager.listAll()).map((session) => session.cwd));
        } catch (error) {
          ctx.ui.notify(`无法读取部分 Pi 历史工作区：${error instanceof Error ? error.message : String(error)}`, "warning");
        }
        const initialWorkspace = await shared.workspaces.add(ctx.cwd);
        if (shared.selected === "tui") shared.activeWorkspaceId = initialWorkspace.id;
        // Pi's /reload re-evaluates extensions but retains this process-wide state.
        // Replace an older bridge so new authenticated endpoints are available.
        if (shared.bridge && (shared.bridge.protocolVersion !== 7 || shared.bridge.buildId !== buildId || typeof shared.bridge.reportError !== "function")) {
          const previous = shared.bridge;
        if (shared.workspaceSessions && shared.workspaceSessions.telemetryVersion !== 2 && shared.workspaceSessions.session && !shared.workspaceSessions.session.isIdle) throw new Error("请等待当前回复结束再切换工作区");
          shared.bridge = null;
          await previous.close();
          await shared.telemetry.close();
          shared.telemetry = new NodeTelemetry();
        }
        if (shared.bridge === null) {
          const legacy = shared.workspaceSessions?.telemetryVersion !== 2 ? shared.workspaceSessions : null;
          const retained = legacy?.session && legacy.path ? { path: legacy.path, sessionManager: legacy.session.sessionManager } : null;
          if (legacy) { await legacy.dispose(); shared.workspaceSessions = null; }
          shared.workspaceSessions ??= new WorkspaceSessions((event) => {
            if (shared.selected === "sdk") {
              shared.bridge?.publish(event);
              if (event.type === "snapshot" && event.session.idle) void publishWorkspaces();
            }
          }, () => shared.current?.model, (cwd) => {
            try { return !!shared.current && realpathSync(shared.current.cwd) === cwd && (shared.current.isProjectTrusted?.() ?? false); }
            catch { return false; }
          }, (cause, context) => shared.bridge?.reportError?.(cause, context), {
            enabled: () => !!shared.telemetry?.enabled && !!shared.bridge,
            breadcrumb: (category, context) => shared.bridge?.breadcrumb?.(category, context),
            anonymize: value => shared.telemetry?.session(value) ?? "unavailable",
          });
          if (retained) await shared.workspaceSessions.open(retained.path, { sessionManager: retained.sessionManager });
          const host: BridgeHost = {
            selfUpdate: new SelfUpdater({ agentDir: getAgentDir(), packageRoot: resolve(webRoot, "../.."), launcherNonce: process.env.PI_WEBAPP_LAUNCHER_NONCE }),
            snapshot,
            plugins: async () => {
              const catalog = activeCatalog();
              await catalog?.refreshAssets();
              return catalog?.view() ?? { plugins: [], errors: [] };
            },
            pluginAsset: async (path) => activeCatalog()?.asset(path) ?? null,
            async invokePluginAction(sessionId, pluginId, action, input) {
              activeSession(sessionId);
              if (!activeCatalog()?.has(pluginId)) throw new Error("插件未启用");
              const selected = shared.selected;
              const generation = shared.tuiGeneration;
              const workspaceSession = shared.workspaceSessions?.session;
              const request = { requestId: randomUUID(), sessionId, pluginId, action, input };
              const result = shared.selected === "sdk"
                ? await shared.workspaceSessions!.invokePluginAction(request)
                : await invokeWebAction(shared.pi!.events, request, 15_000, shared.tuiWaitController.signal);
              activeSession(sessionId);
              if (selected !== shared.selected || (selected === "tui" ? generation !== shared.tuiGeneration : workspaceSession !== shared.workspaceSessions?.session)) throw new Error("会话运行实例已切换");
              if (shared.selected === "tui" && shared.current) publishSnapshot(shared.current);
              return result;
            },
            async resolvePluginInteraction(sessionId, pluginId, requestId, value) {
              activeSession(sessionId);
              if (!activeCatalog()?.has(pluginId)) throw new Error("插件未启用");
              if (shared.selected === "sdk") shared.workspaceSessions!.resolveInteraction(sessionId, pluginId, requestId, value);
              else shared.interactions!.resolve(sessionId, pluginId, requestId, value);
            },
            image(sessionId, messageId, index) {
              activeSession(sessionId);
              const entries = shared.selected === "sdk"
                ? shared.workspaceSessions?.session?.sessionManager.getBranch()
                : shared.current?.sessionManager.getBranch();
              const entry = entries?.find((candidate) => candidate.id === messageId);
              if (entry?.type !== "message" || entry.message.role !== "user" || !Array.isArray(entry.message.content)) return null;
              const part = entry.message.content[index];
              if (part?.type !== "image") return null;
              return { data: Buffer.from(part.data, "base64"), mimeType: part.mimeType };
            },
            async workspaces() { return workspaceList(); },
            async addWorkspace(path, create) {
              const workspace = await shared.workspaces!.add(path, create);
              try { await selectWorkspace(workspace.id, true); }
              catch (error) { await publishWorkspaces(); throw error; }
            },
            async selectWorkspace(id) { await selectWorkspace(id); },
            async newSessionInWorkspace(id) { await selectWorkspace(id, true); },
            async removeWorkspace(id) {
              if (id === shared.activeWorkspaceId) throw new Error("请先切换到其他工作区");
              await shared.workspaces!.remove(id);
              await publishWorkspaces();
            },
            async selectSession(workspaceId, id, path) {
              const workspace = shared.workspaces?.get(workspaceId);
              if (!workspace) throw new Error("工作区不存在");
              if (id === shared.current?.sessionManager.getSessionId() && workspace.path === await realpath(shared.current.cwd)) {
                if (shared.selected === "sdk" && shared.workspaceSessions?.session && !shared.workspaceSessions.session.isIdle) throw new Error("请等待当前回复结束再切换会话");
                shared.selected = "tui";
                shared.activeWorkspaceId = workspaceId;
                shared.bridge?.publish({ type: "snapshot", session: snapshot() });
              } else {
                if (shared.selected === "sdk" && shared.workspaceSessions?.session?.sessionManager.getSessionId() === id && shared.workspaceSessions.path === workspace.path) return;
                const saved = await sessionsForWorkspace(workspace.path);
                if (!saved.some((item) => item.id === id && item.path === path)) throw new Error("会话不属于该工作区");
                await shared.workspaceSessions!.open(workspace.path, { sessionFile: path });
                shared.selected = "sdk";
                shared.activeWorkspaceId = workspaceId;
                shared.bridge?.publish({ type: "snapshot", session: snapshot() });
              }
              await publishWorkspaces();
            },
            async models() {
              if (shared.selected === "sdk") return shared.workspaceSessions?.models() ?? [];
              const active = shared.current;
              if (!active) throw new Error("没有活动会话");
              const scoped = active.scopedModels?.map((item) => `${item.model.provider}/${item.model.id}`) ?? [];
              return active.modelRegistry.getAvailable()
                .filter((model) => scoped.length === 0 || scoped.includes(`${model.provider}/${model.id}`))
                .map((model) => ({ provider: model.provider, id: model.id, name: model.name }));
            },
            async providers() {
              const runtime = await currentProviderRuntime();
              const stored = new Set((await runtime.listCredentials()).map((entry) => entry.providerId));
              return runtime.getProviders().map((provider) => ({
                id: provider.id,
                name: provider.name,
                configured: runtime.getProviderAuthStatus(provider.id).configured,
                storedCredential: stored.has(provider.id),
                methods: [provider.auth.apiKey?.login ? "api_key" : null, provider.auth.oauth ? "oauth" : null].filter((value): value is LoginMethod => value !== null),
              }));
            },
            async providerModels(providerId: string) {
              const runtime = await currentProviderRuntime();
              return getProviderModels(join(getAgentDir(), "models.json"), providerId, runtime);
            },
            async updateProviderModel(sessionId: string, providerId: string, change: ModelChange) {
              activeSession(sessionId);
              if (shared.selected === "tui" ? !sameSession(sessionId).isIdle() : !shared.workspaceSessions?.session?.isIdle) throw new Error("Pi 正在运行，请等待当前回复结束");
              const selectedModel = snapshot().model;
              if (change.action === "remove" && selectedModel === `${providerId}/${change.id}`) throw new Error("请先切换当前使用的模型");
              if (change.action === "save" && change.originalId && change.originalId !== change.model.id && selectedModel === `${providerId}/${change.originalId}`) throw new Error("请先切换当前使用的模型");
              const runtime = await currentProviderRuntime();
              await updateProviderModel(join(getAgentDir(), "models.json"), providerId, change, runtime);
              await runtime.refresh({ providers: [providerId], allowNetwork: false });
              await shared.current?.modelRegistry.refresh({ providers: [providerId], allowNetwork: false });
              await shared.workspaceSessions?.session?.modelRuntime.refresh({ providers: [providerId], allowNetwork: false });
              const affectedModelId = change.action === "save" ? change.model.id : change.action === "base_url" && selectedModel?.startsWith(`${providerId}/`) ? selectedModel.slice(providerId.length + 1) : null;
              if (affectedModelId && selectedModel === `${providerId}/${affectedModelId}`) {
                if (shared.selected === "sdk") {
                  try { await shared.workspaceSessions!.setModel(providerId, affectedModelId); }
                  catch { throw new Error("模型已保存，请重新选择该模型以应用新参数"); }
                }
                else {
                  const active = sameSession(sessionId);
                  const model = active.modelRegistry.find(providerId, affectedModelId);
                  if (!model || !shared.pi || !await shared.pi.setModel(model)) throw new Error("模型已保存，请重新选择该模型以应用新参数");
                  publishSnapshot(active);
                }
              }
            },
            async logoutProvider(sessionId: string, providerId: string) {
              activeSession(sessionId);
              if (shared.selected === "tui" ? !sameSession(sessionId).isIdle() : !shared.workspaceSessions?.session?.isIdle) throw new Error("Pi 正在运行，请等待当前回复结束");
              const runtime = await currentProviderRuntime();
              if (!(await runtime.listCredentials()).some((entry) => entry.providerId === providerId)) throw new Error("该提供方没有已保存的认证");
              await runtime.logout(providerId);
              await shared.current?.modelRegistry.refresh({ providers: [providerId], allowNetwork: false });
              await shared.workspaceSessions?.session?.modelRuntime.refresh({ providers: [providerId], allowNetwork: false });
            },
            async loginProvider(providerId: string, method: LoginMethod, interaction: AuthInteraction) {
              const runtime = await currentProviderRuntime();
              await runtime.login(providerId, method, preferBrowserLogin(providerId, method, interaction));
              await runtime.refresh({ providers: [providerId], allowNetwork: false });
              await shared.current?.modelRegistry.refresh({ providers: [providerId], allowNetwork: false });
              await shared.workspaceSessions?.session?.modelRuntime.refresh({ providers: [providerId], allowNetwork: false });
            },
            async addCustomProvider(sessionId: string, input: CustomProviderInput) {
              activeSession(sessionId);
              if (shared.selected === "tui" ? !sameSession(sessionId).isIdle() : !shared.workspaceSessions?.session?.isIdle) throw new Error("Pi 正在运行，请等待当前回复结束");
              const runtime = await currentProviderRuntime();
              if (runtime.getProvider(input.id)) throw new Error("提供方已存在");
              await addCustomProvider(join(getAgentDir(), "models.json"), input);
              await runtime.refresh({ allowNetwork: false });
              await shared.current?.modelRegistry.refresh({ allowNetwork: false });
              await shared.workspaceSessions?.session?.modelRuntime.refresh({ allowNetwork: false });
            },
            commands() {
              return shared.selected === "tui" ? (shared.pi?.getCommands() ?? []).filter((command) => command.name !== "web" && command.name !== "web-dev-reload").map((command) => ({ name: command.name, description: command.description })) : [];
            },
            async compact(sessionId) {
              activeSession(sessionId);
              if (shared.selected === "sdk") {
                const session = shared.workspaceSessions?.session;
                if (!session || !session.isIdle) throw new Error("请等待当前回复结束");
                await session.compact();
                shared.bridge?.publish({ type: "snapshot", session: snapshot() });
                return;
              }
              const active = sameSession(sessionId);
              if (!active.isIdle()) throw new Error("请等待当前回复结束");
              active.compact();
            },
            async setModel(sessionId, provider, id) {
              activeSession(sessionId);
              if (shared.selected === "sdk") { await shared.workspaceSessions!.setModel(provider, id); return; }
              const active = sameSession(sessionId);
              if (!active.isIdle()) throw new Error("Pi 正在运行，请等待当前回复结束");
              const model = active.modelRegistry.find(provider, id);
              if (!model || !active.modelRegistry.getAvailable().some((available) => available.provider === provider && available.id === id)) throw new Error("模型不可用");
              if (!shared.pi || !await shared.pi.setModel(model)) throw new Error("模型提供方未配置认证");
              publishSnapshot(active);
            },
            async setThinkingLevel(sessionId, level) {
              activeSession(sessionId);
              const allowed = ["off", "minimal", "low", "medium", "high", "xhigh"];
              if (!allowed.includes(level)) throw new Error("推理强度无效");
              if (shared.selected === "sdk") {
                const session = shared.workspaceSessions?.session;
                if (!session || !session.isIdle || !session.getAvailableThinkingLevels().includes(level as typeof session.thinkingLevel)) throw new Error("当前模型不支持此推理强度");
                session.setThinkingLevel(level as typeof session.thinkingLevel);
                shared.bridge?.publish({ type: "snapshot", session: snapshot() });
                return;
              }
              const active = sameSession(sessionId);
              if (!active.isIdle()) throw new Error("Pi 正在运行，请等待当前回复结束");
              if (!active.model || !getSupportedThinkingLevels(active.model).includes(level as NonNullable<typeof active.thinkingLevel>)) throw new Error("当前模型不支持此推理强度");
              if (!shared.pi) throw new Error("Pi 会话不可用");
              shared.pi.setThinkingLevel(level as NonNullable<typeof active.thinkingLevel>);
              publishSnapshot(active);
            },
            config: configView,
            updateConfig: changeConfig,
            async send(sessionId, text, images = [], correlation) {
              activeSession(sessionId);
              if (shared.selected === "sdk") {
                await shared.workspaceSessions!.send(text, images, correlation);
                return;
              }
              const active = sameSession(sessionId);
              if (!active.isIdle()) throw new Error("Pi 正在运行，请等待当前回复结束");
              shared.operation = correlation;
              try {
                shared.bridge?.breadcrumb?.("send", { ...correlation, piVersion: VERSION });
                if (shared.replacementContext !== null && shared.replacementSessionId === sessionId) {
                  await shared.replacementContext.sendUserMessage(images.length ? [{ type: "text", text }, ...images] : text, { expandPromptTemplates: true });
                  return;
                }
                if (shared.pi === null) throw new Error("Pi 会话不可用");
                shared.pi.sendUserMessage(images.length ? [{ type: "text", text }, ...images] : text, { expandPromptTemplates: true });
              } catch (cause) { shared.operation = undefined; throw cause; }
            },
            async abort(sessionId) {
              activeSession(sessionId);
              if (shared.selected === "sdk") await shared.workspaceSessions!.stop();
              else {
                const active = sameSession(sessionId);
                if (active.isIdle()) return;
                if (!shared.pi) throw new Error("Pi 会话不可用");
                shared.tools?.cancel();
                shared.bridge?.breadcrumb?.("cancel", { ...shared.operation });
                shared.pi.appendEntry(PAUSED_ENTRY);
                active.abort();
              }
            },
            async resume(sessionId, correlation) {
              activeSession(sessionId);
              if (shared.selected === "sdk") { await shared.workspaceSessions!.resume(correlation); return; }
              const active = sameSession(sessionId);
              if (!active.isIdle()) throw new Error("Pi 正在运行，请等待当前回复结束");
              if (!active.model || !shared.pi) throw new Error("请先选择模型");
              if (!active.modelRegistry.hasConfiguredAuth(active.model)) throw new Error("请先连接当前模型");
              shared.operation = correlation;
              try { shared.pi.sendMessage(resumeMessage(snapshot().messages), { triggerTurn: true }); }
              catch (cause) { shared.operation = undefined; throw cause; }
            },
            async newSession(sessionId) {
              activeSession(sessionId);
              if (shared.selected === "sdk") {
                const workspace = shared.workspaces?.get(shared.activeWorkspaceId ?? "");
                if (!workspace) throw new Error("工作区不存在");
                await shared.workspaceSessions!.open(workspace.path, "new");
                await publishWorkspaces();
                return;
              }
              const active = sameSession(sessionId);
              if (!active.isIdle()) throw new Error("Pi 正在运行，请等待当前回复结束");
              if (shared.commandContext === null) {
                await shared.workspaceSessions!.open(active.cwd, "new");
                shared.selected = "sdk";
                shared.bridge?.publish({ type: "snapshot", session: snapshot() });
                await publishWorkspaces();
                return;
              }
              const result = await shared.commandContext.newSession({
                withSession: async (ctx) => {
                  shared.commandContext = ctx;
                  shared.replacementContext = ctx;
                  shared.replacementSessionId = ctx.sessionManager.getSessionId();
                  shared.current = ctx;
                },
              });
              if (result.cancelled) throw new Error("新会话已取消");
              await publishWorkspaces();
            },
          };
          host.addWorkspace = shared.lifecycle.wrap(host.addWorkspace);
          host.selectWorkspace = shared.lifecycle.wrap(host.selectWorkspace);
          host.newSessionInWorkspace = shared.lifecycle.wrap(host.newSessionInWorkspace);
          host.removeWorkspace = shared.lifecycle.wrap(host.removeWorkspace);
          host.selectSession = shared.lifecycle.wrap(host.selectSession);
          host.newSession = shared.lifecycle.wrap(host.newSession);
          host.updateConfig = shared.lifecycle.wrap(host.updateConfig);
          shared.bridge = await startBridge(host, webRoot, shared.telemetry);
        }
        if (shared.stopPluginWatch === null && process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS) {
          const watchers: FSWatcher[] = [];
          let refreshTimer: ReturnType<typeof setTimeout> | null = null;
          for (const root of (process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS ?? "").split(delimiter).filter(Boolean)) {
            try {
              watchers.push(watch(join(resolve(root), "dist"), (_event, file) => {
                const name = String(file ?? "");
                if (!["client.js", "client.css"].includes(name)) return;
                if (refreshTimer) clearTimeout(refreshTimer);
                refreshTimer = setTimeout(() => shared.bridge?.publish({ type: "plugins_changed" }), 180);
              }));
            } catch (error) { shared.bridge?.publish({ type: "error", message: `插件监听失败：${root}: ${String(error)}` }); }
          }
          shared.stopPluginWatch = () => { for (const watcher of watchers) watcher.close(); if (refreshTimer) clearTimeout(refreshTimer); };
        }
        const opened = await openPage(shared.bridge.url).catch(() => false);
        ctx.ui.notify(`pi-webapp: ${shared.bridge.url}`, opened ? "info" : "warning");
        ctx.ui.setStatus("pi-webapp", "Web 已启动 · /web 重新打开");
      } catch (cause) {
        shared.telemetry?.capture(cause, { stage: "open_web", piVersion: VERSION });
        if (!shared.bridge) { await shared.telemetry?.close(); shared.telemetry = null; }
        throw cause;
      }
  };
  pi.registerCommand("web", {
    description: "Open the current Pi session in a local web interface",
    handler: async (_args, ctx) => openWeb(ctx),
  });
  pi.registerCommand("web-dev-reload", {
    description: "Reload local pi-webapp plugins during development",
    handler: async (_args, ctx) => {
      if (!process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS) return;
      await ctx.waitForIdle();
      await shared.lifecycle.run(async () => {
        const sdk = shared.workspaceSessions?.session;
        if (sdk) { await sdk.waitForIdle(); await shared.workspaceSessions!.reload(); }
        await ctx.reload();
      });
    },
  });
}
