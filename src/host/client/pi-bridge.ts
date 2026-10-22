import { localize as t, useLocale } from "../../../web/src/ui/locale/preference.ts";
import { useEffect, useState } from "react";
import type {
  ViewMessage as WireViewMessage, SessionView as WireSessionView, WebPluginCatalogView,
  WorkspaceListView, DirectoryListing, DirectoryPickerKind, ModelOption, CommandOption,
  AttachmentReceipt, ConfigKind, ConfigScope, ConfigView, UpdateStatus, LoginMethod,
  ProviderView, ProviderModelsView, ProviderModelChange, CustomProviderInput, LoginView, BridgeEvent, PromptDelivery,
} from "../../contracts/bridge-contract.ts";
import { parseBridgeEvent } from "../../contracts/bridge-events.ts";
export type {
  ViewBlock, ViewUsage, WorkspaceView, WorkspaceSessionView, WorkspaceListView,
  DirectoryEntry, DirectoryListing, DirectoryPickerKind, ModelOption, CommandOption,
  AttachmentReceipt, ConfigKind, ConfigScope, ResourceItem, ConfigView, UpdateStatus,
  LoginMethod, ProviderView, ProviderModelFields, ProviderModelRow, ProviderModelsView,
  ProviderModelChange, CustomProviderInput, LoginPrompt, LoginEvent, LoginView,
} from "../../contracts/bridge-contract.ts";
import { accessToken } from "./access-token.ts";
import { bridgeFetch, bridgeJson } from "./telemetry-fetch.ts";
import { breadcrumb, reportError, setTelemetryState } from "./telemetry.ts";
import type { ErrorCorrelation } from "../../contracts/telemetry.ts";
import type { PluginManagementView, PluginToggle } from "../../contracts/plugins.ts";

/** Optimistic presentation state is deliberately not part of the wire DTO. */
export interface ViewMessage extends WireViewMessage { localFiles?: File[] }
export interface SessionView extends Omit<WireSessionView, "messages" | "streaming"> {
  messages: ViewMessage[];
  streaming?: ViewMessage | null;
}
export type ConnectionState = "missing-token" | "connecting" | "connected" | "disconnected";
export type ModelsStatus = "loading" | "ready" | "error";

const token = accessToken();

async function post(path: string, body: object, signal?: AbortSignal) {
  return bridgeJson(await bridgeFetch(path, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body), signal,
  }));
}

async function get<T>(path: string): Promise<T> {
  return bridgeJson(await bridgeFetch(path, { headers: { Authorization: `Bearer ${token}` } })) as Promise<T>;
}

export function usePiBridge() {
  const locale = useLocale();
  const [session, setSession] = useState<SessionView | null>(null);
  const [streaming, setStreaming] = useState<ViewMessage | null>(null);
  const [connection, setConnection] = useState<ConnectionState>(token ? "connecting" : "missing-token");
  const [error, setError] = useState("");
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelsStatus, setModelsStatus] = useState<ModelsStatus>("loading");
  const [commands, setCommands] = useState<CommandOption[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceListView>({ items: [], activeId: null, sessions: [] });
  const [directoryPickerKind, setDirectoryPickerKind] = useState<DirectoryPickerKind | null>(null);
  const [disabledPlugins, setDisabledPlugins] = useState<string[]>([]);
  const [pluginGeneration, setPluginGeneration] = useState(0);

  useEffect(() => {
    if (!token) {
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let alive = true;
    let streamingActive = false;

    const follow = async () => {
      while (alive) {
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        let correlation: ErrorCorrelation | undefined;
        let stage = "stream_connect";
        try {
          setConnection("connecting");
          const followed = await bridgeFetch("/api/events", {
            headers: { Authorization: `Bearer ${token}` },
            signal: controller.signal,
          });
          const { response } = followed;
          correlation = followed.correlation;
          if (!response.ok) await bridgeJson(followed);
          if (!response.body) {
            throw new Error(response.status === 401 ? t("访问令牌无效，请在 Pi 中重新输入 /web。", "Invalid access token. Run /web again in Pi.") : t("连接 Pi 失败", "Could not connect to Pi"));
          }
          setConnection("connected");
          setTelemetryState({ connection: "connected" });
          breadcrumb("stream_connected", { ...correlation });
          setError("");
          reader = response.body.getReader();
          const decoder = new TextDecoder();
          let pending = "";
          while (alive) {
            stage = "stream_read";
            const { done, value } = await reader.read();
            if (done) break;
            stage = "stream_event";
            pending += decoder.decode(value, { stream: true });
            let end = pending.indexOf("\n");
            while (end !== -1) {
              const line = pending.slice(0, end);
              pending = pending.slice(end + 1);
              if (line) {
                let event: BridgeEvent;
                try { event = parseBridgeEvent(JSON.parse(line)); } catch (cause) {
                  // JSON SyntaxError messages may contain conversation or credential fragments.
                  const diagnostic = cause instanceof SyntaxError ? new Error("Invalid event JSON") : cause;
                  reportError(diagnostic, { ...correlation, stage: "ndjson_parse" });
                  throw diagnostic;
                }
                if (event.type === "shutdown") {
                  void reader.cancel().catch(() => {});
                  if (event.reconnect === true) throw new DOMException("Pi web service is restarting", "AbortError");
                  alive = false;
                  setConnection("disconnected"); setTelemetryState({ connection: "disconnected" });
                  breadcrumb("bridge_shutdown");
                  setError(t("Pi 网页服务已关闭，请在 Pi 中重新输入 /web。", "The Pi web service stopped. Run /web again in Pi."));
                  return;
                }
                if (event.type === "snapshot") {
                  setSession(event.session);
                  setTelemetryState({ sessionId: event.session.sessionId, idle: event.session.idle, model: event.session.model, thinkingLevel: event.session.thinkingLevel, messageCount: event.session.messages?.length ?? 0 });
                  if (event.session.idle || "streaming" in event.session) setStreaming(event.session.streaming ?? null);
                }
                if (event.type === "stream") {
                  const active = event.message !== null;
                  if (active !== streamingActive) breadcrumb(active ? "stream_start" : "stream_end");
                  streamingActive = active;
                  setStreaming(event.message);
                }
                if (event.type === "workspaces") setWorkspaces(event.value);
                if (event.type === "error") {
                  setError(event.message);
                  if (!event.errorId && !event.errorReported && event.errorCode !== "validation_error") reportError(new Error("Agent response failed"), { stage: "agent", code: "agent_failed", requestId: event.requestId, operationId: event.operationId });
                  breadcrumb("agent_error", { errorId: event.errorId, requestId: event.requestId, operationId: event.operationId });
                }
                if (event.type === "plugins_changed") window.location.reload();
                if (event.type === "plugin_state") { setDisabledPlugins(event.disabled); setPluginGeneration(value => value + 1); }
              }
              end = pending.indexOf("\n");
            }
          }
          stage = "stream_end";
          throw new Error(t("Pi 网页连接已关闭", "The Pi web connection has closed"));
        } catch (cause) {
          void reader?.cancel().catch(() => {});
          if (!alive) return;
          setTelemetryState({ connection: "disconnected" });
          const context = { ...correlation, route: "/api/events", stage, connection: "disconnected" };
          reportError(cause, context);
          breadcrumb("stream_disconnected", context);
          setConnection("disconnected");
          setModelsStatus("loading");
          setError(cause instanceof Error ? cause.message : t("连接 Pi 失败", "Could not connect to Pi"));
          await new Promise<void>((resolve) => { timer = setTimeout(resolve, 1500); });
        }
      }
    };
    void follow();
    return () => {
      alive = false;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!token) setError(t("请在 Pi 终端输入 /web，打开显示的完整地址。", "Enter /web in the Pi terminal and open the full address shown."));
  }, [locale]);

  useEffect(() => {
    if (connection !== "connected") return;
    let active = true;
    setModelsStatus("loading");
    void get<PluginManagementView>("/api/plugin-management").then(view => { if (active) setDisabledPlugins(view.items.filter(plugin => !plugin.enabled).map(plugin => plugin.id)); }).catch(() => { /* Catalog loading reports management availability separately. */ });
    void get<ModelOption[]>("/api/models").then((items) => { if (active) { setModels(items); setModelsStatus("ready"); } }).catch((cause) => {
      if (active) { setModelsStatus("error"); setError(cause instanceof Error ? cause.message : t("无法获取模型列表", "Could not load the model list")); }
    });
    void get<CommandOption[]>("/api/commands").then((items) => { if (active) setCommands(items); }).catch(() => { if (active) setCommands([]); });
    return () => { active = false; };
  }, [connection, session?.sessionId]);

  useEffect(() => {
    if (connection !== "connected") return;
    let active = true;
    void get<WorkspaceListView>("/api/workspaces").then((value) => { if (active) setWorkspaces(value); }).catch(() => {});
    void get<{ kind: DirectoryPickerKind }>("/api/directory/capability").then((value) => { if (active) setDirectoryPickerKind(value.kind); }).catch(() => { if (active) setDirectoryPickerKind("browse"); });
    return () => { active = false; };
  }, [connection]);

  return {
    session,
    streaming,
    connection,
    error,
    models,
    modelsStatus,
    commands,
    workspaces,
    directoryPickerKind,
    async resolvePluginInteraction(pluginId: string, requestId: string, value: unknown): Promise<void> {
      if (!session) throw new Error("No active session");
      await post("/api/plugin-interaction", { sessionId: session.sessionId, pluginId, requestId, value });
    },
    plugins: () => get<WebPluginCatalogView>("/api/plugins"),
    async invokePluginAction<T = unknown>(pluginId: string, action: string, input?: unknown): Promise<T> {
      if (!session || connection !== "connected") throw new Error(t("Pi 会话不可用", "Pi session is unavailable"));
      const response = await post("/api/plugin-action", { sessionId: session.sessionId, pluginId, action, input }) as { value: T };
      return response.value;
    },
    async pickDirectory(): Promise<string | null> {
      if (!session || connection !== "connected") throw new Error(t("Pi 会话不可用", "Pi session is unavailable"));
      const result = await post("/api/directory/pick", { sessionId: session.sessionId });
      return result.path;
    },
    async listDirectory(path?: string, signal?: AbortSignal): Promise<DirectoryListing> {
      if (!session || connection !== "connected") throw new Error(t("Pi 会话不可用", "Pi session is unavailable"));
      return post("/api/directory/list", { sessionId: session.sessionId, ...(path === undefined ? {} : { path }) }, signal);
    },
    async createDirectory(path: string, name: string): Promise<string> {
      if (!session || connection !== "connected") throw new Error(t("Pi 会话不可用", "Pi session is unavailable"));
      const result = await post("/api/directory/create", { sessionId: session.sessionId, path, name });
      return result.path;
    },
    disabledPlugins, pluginGeneration,
    getPluginManagement: () => get<PluginManagementView>("/api/plugin-management"),
    async togglePlugin(input: PluginToggle): Promise<PluginManagementView> {
      if (!session || connection !== "connected") throw new Error(t("Pi 会话不可用", "Pi session is unavailable"));
      return post("/api/plugin-management", { sessionId: session.sessionId, ...input });
    },
    clearError: () => setError(""),
    async upload(file: File, signal?: AbortSignal): Promise<AttachmentReceipt> {
      if (!session || connection !== "connected") throw new Error(t("Pi 会话不可用", "Pi session is unavailable"));
      const url = `/api/attachment?sessionId=${encodeURIComponent(session.sessionId)}&name=${encodeURIComponent(file.name)}`;
      const uploaded = await bridgeFetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": file.type || "application/octet-stream" },
        body: file,
        signal,
      });
      const response = uploaded.response;
      if (response.status === 404) throw new Error(t("当前 Pi 桥接服务仍是旧版。请在 Pi 中输入 /reload，再输入 /web 并打开新地址，然后重试上传。", "The Pi bridge is outdated. Run /reload, then /web in Pi, open the new address, and retry the upload."));
      return await bridgeJson(uploaded) as AttachmentReceipt;
    },
    async discardAttachment(id: string): Promise<void> {
      if (!session || connection !== "connected") return;
      await post("/api/attachment/remove", { sessionId: session.sessionId, id });
    },
    async send(text: string, attachments: string[] = [], delivery?: PromptDelivery) {
      if (!session || connection !== "connected") return;
      setError("");
      try { await post("/api/message", { sessionId: session.sessionId, text, attachments, delivery }); }
      catch (cause) { setError(cause instanceof Error ? cause.message : t("发送失败", "Send failed")); throw cause; }
    },
    async loadMessageImage(messageId: string, index: number): Promise<Blob> {
      if (!session || connection !== "connected") throw new Error(t("Pi 会话不可用", "Pi session is unavailable"));
      const url = `/api/image?sessionId=${encodeURIComponent(session.sessionId)}&messageId=${encodeURIComponent(messageId)}&index=${index}`;
      const result = await bridgeFetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!result.response.ok) await bridgeJson(result);
      try { return await result.response.blob(); } catch (cause) { reportError(cause, { ...result.correlation, stage: "image_read" }); throw cause; }
    },
    async stop() {
      if (!session || connection !== "connected") return;
      try { await post("/api/abort", { sessionId: session.sessionId }); setError(""); }
      catch (cause) { setError(cause instanceof Error ? cause.message : t("停止失败", "Could not stop")); throw cause; }
    },
    async resume() {
      if (!session || connection !== "connected") throw new Error(t("Pi 会话不可用", "Pi session is unavailable"));
      setError("");
      try { await post("/api/resume", { sessionId: session.sessionId }); }
      catch (cause) { setError(cause instanceof Error ? cause.message : t("继续失败", "Could not continue")); throw cause; }
    },
    async compact() {
      if (!session || connection !== "connected") throw new Error(t("Pi 会话不可用", "Pi session is unavailable"));
      try { await post("/api/compact", { sessionId: session.sessionId }); setError(""); }
      catch (cause) { setError(cause instanceof Error ? cause.message : t("压缩失败", "Compaction failed")); throw cause; }
    },
    async newSession() {
      if (!session || connection !== "connected") return;
      try { await post("/api/new-session", { sessionId: session.sessionId }); }
      catch (cause) { setError(cause instanceof Error ? cause.message : t("无法创建新会话", "Could not create a new session")); throw cause; }
    },
    async addWorkspace(path: string, create: boolean) {
      if (!session || connection !== "connected") throw new Error(t("Pi 会话不可用", "Pi session is unavailable"));
      await post("/api/workspace/add", { sessionId: session.sessionId, path, create });
    },
    async selectWorkspace(id: string) {
      if (!session || connection !== "connected") throw new Error(t("Pi 会话不可用", "Pi session is unavailable"));
      await post("/api/workspace/select", { sessionId: session.sessionId, id });
    },
    async newSessionInWorkspace(id: string) {
      if (!session || connection !== "connected") throw new Error(t("Pi 会话不可用", "Pi session is unavailable"));
      await post("/api/workspace/new-session", { sessionId: session.sessionId, id });
    },
    async removeWorkspace(id: string) {
      if (!session || connection !== "connected") throw new Error(t("Pi 会话不可用", "Pi session is unavailable"));
      await post("/api/workspace/remove", { sessionId: session.sessionId, id });
    },
    async selectSession(workspaceId: string, id: string, path: string | null) {
      if (!session || connection !== "connected") throw new Error(t("Pi 会话不可用", "Pi session is unavailable"));
      await post("/api/session/select", { sessionId: session.sessionId, workspaceId, id, path: path ?? "" });
    },
    async setModel(provider: string, id: string) {
      if (!session || connection !== "connected") return;
      try { await post("/api/model", { sessionId: session.sessionId, provider, id }); setError(""); }
      catch (cause) { setError(cause instanceof Error ? cause.message : t("切换模型失败", "Could not change model")); throw cause; }
    },
    async setThinkingLevel(level: string) {
      if (!session || connection !== "connected") return;
      try { await post("/api/thinking-level", { sessionId: session.sessionId, level }); setError(""); }
      catch (cause) { setError(cause instanceof Error ? cause.message : t("切换推理强度失败", "Could not change reasoning effort")); throw cause; }
    },
    async getConfig() { return get<ConfigView>("/api/config"); },
    async getUpdate() { return get<UpdateStatus>("/api/update"); },
    async getRunningVersion(signal?: AbortSignal) {
      // Restart polling expects the service to be briefly unavailable; HTTP/parse errors still report normally.
      return bridgeJson(await bridgeFetch("/api/update/version", { headers: { Authorization: `Bearer ${token}` }, signal }, { expectedNetworkFailure: true })) as Promise<{ current: string | null }>;
    },
    async update(): Promise<{ version: string }> {
      if (!session || connection !== "connected") throw new Error(t("Pi 会话不可用", "Pi session is unavailable"));
      return post("/api/update", { sessionId: session.sessionId });
    },
    async getProviders() { return get<ProviderView[]>("/api/providers"); },
    async getProviderModels(providerId: string) { return get<ProviderModelsView>(`/api/provider/models?providerId=${encodeURIComponent(providerId)}`); },
    async updateProviderModel(providerId: string, change: ProviderModelChange): Promise<void> {
      if (!session || connection !== "connected") throw new Error(t("Pi 会话不可用", "Pi session is unavailable"));
      await post("/api/provider/models", { sessionId: session.sessionId, providerId, change });
      try { setModels(await get<ModelOption[]>("/api/models")); setModelsStatus("ready"); }
      catch { setError(t("模型已保存，但会话模型列表暂时无法刷新。", "Model saved, but the conversation model list could not refresh.")); }
    },
    async logoutProvider(providerId: string): Promise<void> {
      if (!session || connection !== "connected") throw new Error(t("Pi 会话不可用", "Pi session is unavailable"));
      await post("/api/provider/logout", { sessionId: session.sessionId, providerId });
      try { setModels(await get<ModelOption[]>("/api/models")); setModelsStatus("ready"); }
      catch { setError(t("认证已移除，但会话模型列表暂时无法刷新。", "Credentials removed, but the conversation model list could not refresh.")); }
    },
    async addCustomProvider(provider: CustomProviderInput): Promise<void> {
      if (!session || connection !== "connected") throw new Error(t("Pi 会话不可用", "Pi session is unavailable"));
      await post("/api/provider/custom", { sessionId: session.sessionId, provider });
    },
    async startProviderLogin(providerId: string, method: LoginMethod, initialSecret?: string): Promise<{ id: string }> {
      if (!session || connection !== "connected") throw new Error(t("Pi 会话不可用", "Pi session is unavailable"));
      return post("/api/provider/login", { sessionId: session.sessionId, providerId, method, ...(initialSecret === undefined ? {} : { initialSecret }) });
    },
    async getProviderLogin(id: string) { return get<LoginView>(`/api/provider/login?id=${encodeURIComponent(id)}`); },
    async getActiveProviderLogin() { return (await get<{ active: LoginView | null }>("/api/provider/login/active")).active; },
    async respondProviderLogin(id: string, value: string) {
      if (!session || connection !== "connected") throw new Error(t("Pi 会话不可用", "Pi session is unavailable"));
      await post("/api/provider/login/respond", { sessionId: session.sessionId, id, value });
    },
    async cancelProviderLogin(id: string) {
      if (!session || connection !== "connected") return;
      await post("/api/provider/login/cancel", { sessionId: session.sessionId, id });
    },
    async refreshModels() { setModels(await get<ModelOption[]>("/api/models")); setModelsStatus("ready"); },
    async updateConfig(kind: ConfigKind, scope: ConfigScope, action: "add" | "remove", value: string) {
      if (!session || connection !== "connected") throw new Error(t("Pi 会话不可用", "Pi session is unavailable"));
      return post("/api/config", { sessionId: session.sessionId, kind, scope, action, value }) as Promise<ConfigView>;
    },
  };
}
