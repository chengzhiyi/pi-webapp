import { dirname, join, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DefaultPackageManager, getAgentDir, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels, type AuthInteraction } from "@earendil-works/pi-ai";
import { startBridge, type Bridge, type ConfigChange, type ConfigView, type WorkspaceListView, type WorkspaceSessionView } from "./bridge.ts";
import { contentBlocks, projectSession } from "./view.ts";
import { WorkspaceRegistry, workspaceRegistryPath } from "./workspaces.ts";
import { WorkspaceSessions } from "./workspace-sessions.ts";
import { sessionsForWorkspace } from "./sessions-for-workspace.ts";
import { buildResourceInventory } from "./config-inventory.ts";
import type { LoginMethod } from "./provider-login.ts";
import { addCustomProvider, type CustomProviderInput } from "./custom-provider.ts";
import { openWebPage } from "./open-web-page.ts";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../web/dist");
const stateKey = Symbol.for("pi-web.bridge-state");

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
});
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
  return projectSession(shared.current, shared.current.sessionManager.getSessionName());
}

function activeSession(sessionId: string) {
  if (snapshot().sessionId !== sessionId) throw new Error("会话已切换");
}

async function workspaceList(): Promise<WorkspaceListView> {
  const items = shared.workspaces?.list() ?? [];
  const active = snapshot();
  const activePath = await realpath(active.cwd).catch(() => active.cwd);
  const sessions: WorkspaceSessionView[] = (await Promise.all(items.map(async (workspace) => {
    const saved = await sessionsForWorkspace(workspace.path).catch(() => []);
    const rows: WorkspaceSessionView[] = saved.map((session) => ({ id: session.id, workspaceId: workspace.id, path: session.path, name: session.name || session.firstMessage?.slice(0, 50) || "当前会话", modified: session.modified.toISOString() }));
    if (workspace.path === activePath && !rows.some((session) => session.id === active.sessionId)) {
      rows.unshift({ id: active.sessionId, workspaceId: workspace.id, path: null, name: active.name, modified: new Date().toISOString() });
    }
    return rows;
  }))).flat();
  return { items, activeId: shared.activeWorkspaceId, sessions };
}

async function publishWorkspaces(): Promise<void> {
  if (shared.bridge) shared.bridge.publish({ type: "workspaces", value: await workspaceList() });
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
    await shared.workspaceSessions?.session?.resourceLoader.reload();
    shared.workspaceSessions?.session?.refreshContext();
  }
  return await configView();
}

export default function piWeb(pi: ExtensionAPI, openPage: (url: string) => Promise<boolean> = openWebPage): void {
  shared.pi = pi;

  pi.on("session_start", (_event, ctx) => {
    if (shared.replacementSessionId !== ctx.sessionManager.getSessionId()) {
      shared.replacementContext = null;
      shared.replacementSessionId = null;
    }
    publishSnapshot(ctx);
    if (shared.selected === "tui" && shared.workspaces) {
      void shared.workspaces.add(ctx.cwd).then(async (workspace) => {
        if (shared.selected !== "tui" || shared.current?.sessionManager.getSessionId() !== ctx.sessionManager.getSessionId()) return;
        shared.activeWorkspaceId = workspace.id;
        await publishWorkspaces();
      }).catch((error: unknown) => {
        shared.bridge?.publish({ type: "error", message: error instanceof Error ? error.message : "无法注册当前工作区" });
      });
    }
  });
  pi.on("agent_start", (_event, ctx) => publishSnapshot(ctx));
  pi.on("agent_end", (_event, ctx) => publishSnapshot(ctx));
  pi.on("agent_settled", (_event, ctx) => publishSnapshot(ctx));
  pi.on("model_select", (_event, ctx) => publishSnapshot(ctx));
  pi.on("thinking_level_select", (_event, ctx) => publishSnapshot(ctx));
  pi.on("message_end", (event, ctx) => {
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
  pi.on("session_shutdown", (event) => {
    shared.current = null;
    if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") return;
    const bridge = shared.bridge;
    shared.bridge = null;
    shared.commandContext = null;
    shared.replacementContext = null;
    shared.replacementSessionId = null;
    shared.pi = null;
    shared.workspaceSessions?.dispose();
    shared.workspaceSessions = null;
    shared.selected = "tui";
    shared.activeWorkspaceId = null;
    if (bridge) void bridge.close();
  });

  pi.registerCommand("web", {
    description: "Open the current Pi session in a local web interface",
    handler: async (_args, ctx) => {
      shared.current = ctx;
      shared.commandContext = ctx;
      shared.pi = pi;
      if (shared.workspaces === null) {
        shared.workspaces = new WorkspaceRegistry(workspaceRegistryPath(getAgentDir()));
        await shared.workspaces.load();
      }
      const initialWorkspace = await shared.workspaces.add(ctx.cwd);
      if (shared.selected === "tui") shared.activeWorkspaceId = initialWorkspace.id;
      // Pi's /reload re-evaluates extensions but retains this process-wide state.
      // A bridge created before attachment support must be replaced as well.
      if (shared.bridge && shared.bridge.protocolVersion !== 3) {
        const previous = shared.bridge;
        shared.bridge = null;
        await previous.close();
      }
      if (shared.bridge === null) {
        shared.workspaceSessions = new WorkspaceSessions((event) => {
          if (shared.selected === "sdk") {
            shared.bridge?.publish(event);
            if (event.type === "snapshot" && event.session.idle) void publishWorkspaces();
          }
        }, () => shared.current?.model);
        shared.bridge = await startBridge({
          snapshot,
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
            return runtime.getProviders().map((provider) => ({
              id: provider.id,
              name: provider.name,
              configured: runtime.getProviderAuthStatus(provider.id).configured,
              methods: [provider.auth.apiKey?.login ? "api_key" : null, provider.auth.oauth ? "oauth" : null].filter((value): value is LoginMethod => value !== null),
            }));
          },
          async loginProvider(providerId: string, method: LoginMethod, interaction: AuthInteraction) {
            const runtime = await currentProviderRuntime();
            await runtime.login(providerId, method, interaction);
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
            return shared.selected === "tui" ? (shared.pi?.getCommands() ?? []).filter((command) => command.name !== "web").map((command) => ({ name: command.name, description: command.description })) : [];
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
          async send(sessionId, text, images = []) {
            activeSession(sessionId);
            if (shared.selected === "sdk") {
              await shared.workspaceSessions!.send(text, images);
              return;
            }
            const active = sameSession(sessionId);
            if (!active.isIdle()) throw new Error("Pi 正在运行，请等待当前回复结束");
            if (shared.replacementContext !== null && shared.replacementSessionId === sessionId) {
              await shared.replacementContext.sendUserMessage(images.length ? [{ type: "text", text }, ...images] : text, { expandPromptTemplates: true });
              return;
            }
            if (shared.pi === null) throw new Error("Pi 会话不可用");
            shared.pi.sendUserMessage(images.length ? [{ type: "text", text }, ...images] : text, { expandPromptTemplates: true });
          },
          abort(sessionId) {
            activeSession(sessionId);
            if (shared.selected === "sdk") void shared.workspaceSessions!.stop();
            else sameSession(sessionId).abort();
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
            if (shared.commandContext === null) throw new Error("请在 Pi 中重新输入 /web");
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
        }, webRoot);
      }
      const opened = await openPage(shared.bridge.url).catch(() => false);
      ctx.ui.notify(`pi-webapp: ${shared.bridge.url}`, opened ? "info" : "warning");
      ctx.ui.setStatus("pi-webapp", "Web 已启动 · /web 重新打开");
    },
  });
}
