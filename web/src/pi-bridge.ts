import { localize as t, useLocale } from "./ui/locale/preference.ts";
import { useEffect, useState } from "react";
import { HttpError } from "./http-error.ts";

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
  /** Browser-owned files used only by an optimistic submission echo. */
  localFiles?: File[];
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

export interface WorkspaceView { id: string; path: string; title: string }
export interface WorkspaceSessionView { id: string; workspaceId: string; path: string | null; name: string; modified: string }
export interface WorkspaceListView { items: WorkspaceView[]; activeId: string | null; sessions: WorkspaceSessionView[] }
export interface DirectoryEntry { name: string; path: string; hidden: boolean }
export interface DirectoryListing { path: string; home: string; crumbs: DirectoryEntry[]; entries: DirectoryEntry[]; truncated: boolean }
export type DirectoryPickerKind = "native" | "browse";

export type ConnectionState = "missing-token" | "connecting" | "connected" | "disconnected";
export type ModelsStatus = "loading" | "ready" | "error";
export interface ModelOption { provider: string; id: string; name: string }
export interface CommandOption { name: string; description?: string }
export interface AttachmentReceipt { id: string; name: string; bytes: number }
export type ConfigKind = "packages" | "extensions" | "skills";
export type ConfigScope = "global" | "project";
export interface ResourceItem { name: string; path: string; source: string; scope: "user" | "project" | "temporary"; enabled: boolean }
export interface ConfigView {
  projectTrusted: boolean;
  global: Record<ConfigKind, string[]>;
  project: Record<ConfigKind, string[]>;
  installed: Record<ConfigKind, ResourceItem[]>;
}
export interface UpdateStatus { current: string; latest: string | null; available: boolean; canRestart: boolean; reason?: string }
export type LoginMethod = "api_key" | "oauth";
export interface ProviderView { id: string; name: string; configured: boolean; storedCredential: boolean; methods: LoginMethod[] }
export interface ProviderModelFields { id: string; name?: string; contextWindow?: number; maxTokens?: number; input?: Array<"text" | "image"> }
export interface ProviderModelRow extends ProviderModelFields { source: "builtin" | "custom"; overridden: boolean }
export interface ProviderModelsView { providerId: string; baseUrl?: string; models: ProviderModelRow[] }
export type ProviderModelChange = { action: "save"; originalId?: string; model: ProviderModelFields } | { action: "remove"; id: string } | { action: "base_url"; baseUrl: string | null };
export interface CustomProviderInput { id: string; name: string; baseUrl: string; api: "openai-completions" | "openai-responses" | "anthropic-messages"; modelId: string }
export type LoginPrompt =
  | { type: "text" | "secret" | "manual_code"; message: string; placeholder?: string }
  | { type: "select"; message: string; options: readonly { id: string; label: string; description?: string }[] };
export type LoginEvent =
  | { type: "info"; message: string; links?: readonly { url: string; label?: string }[] }
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; userCode: string; verificationUri: string }
  | { type: "progress"; message: string };
export interface LoginView { id: string; providerId: string; method: LoginMethod; status: "running" | "waiting" | "done" | "error" | "cancelled"; prompt?: LoginPrompt; event?: LoginEvent; authorization?: Extract<LoginEvent, { type: "auth_url" | "device_code" }>; error?: string }

const hashToken = location.hash.slice(1);
if (hashToken) {
  sessionStorage.setItem("pi-web-token", hashToken);
  history.replaceState(null, "", location.pathname);
}
const token = hashToken || sessionStorage.getItem("pi-web-token");

async function post(path: string, body: object, signal?: AbortSignal) {
  const response = await fetch(path, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const result = await response.json();
  if (!response.ok) throw new HttpError(result.error || t(`请求失败：${response.status}`, `Request failed: ${response.status}`), response.status);
  return result;
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
  const result = await response.json();
  if (!response.ok) throw new HttpError(result.error || t(`请求失败：${response.status}`, `Request failed: ${response.status}`), response.status);
  return result as T;
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

  useEffect(() => {
    if (!token) {
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let alive = true;

    const follow = async () => {
      while (alive) {
        try {
          setConnection("connecting");
          const response = await fetch("/api/events", {
            headers: { Authorization: `Bearer ${token}` },
            signal: controller.signal,
          });
          if (!response.ok || !response.body) {
            throw new Error(response.status === 401 ? t("访问令牌无效，请在 Pi 中重新输入 /web。", "Invalid access token. Run /web again in Pi.") : t("连接 Pi 失败", "Could not connect to Pi"));
          }
          setConnection("connected");
          setError("");
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let pending = "";
          while (alive) {
            const { done, value } = await reader.read();
            if (done) break;
            pending += decoder.decode(value, { stream: true });
            let end = pending.indexOf("\n");
            while (end !== -1) {
              const line = pending.slice(0, end);
              pending = pending.slice(end + 1);
              if (line) {
                const event = JSON.parse(line);
                if (event.type === "snapshot" && event.session?.schemaVersion === 1) {
                  setSession(event.session);
                  if (event.session.idle) setStreaming(null);
                }
                if (event.type === "stream") setStreaming(event.message);
                if (event.type === "workspaces") setWorkspaces(event.value);
                if (event.type === "error") setError(event.message);
              }
              end = pending.indexOf("\n");
            }
          }
          throw new Error(t("Pi 网页连接已关闭", "The Pi web connection has closed"));
        } catch (cause) {
          if (!alive) return;
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
    clearError: () => setError(""),
    async upload(file: File, signal?: AbortSignal): Promise<AttachmentReceipt> {
      if (!session || connection !== "connected") throw new Error(t("Pi 会话不可用", "Pi session is unavailable"));
      const url = `/api/attachment?sessionId=${encodeURIComponent(session.sessionId)}&name=${encodeURIComponent(file.name)}`;
      const response = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": file.type || "application/octet-stream" },
        body: file,
        signal,
      });
      const result = await response.json();
      if (response.status === 404) throw new Error(t("当前 Pi 桥接服务仍是旧版。请在 Pi 中输入 /reload，再输入 /web 并打开新地址，然后重试上传。", "The Pi bridge is outdated. Run /reload, then /web in Pi, open the new address, and retry the upload."));
      if (!response.ok) throw new Error(result.error || t(`上传失败：${response.status}`, `Upload failed: ${response.status}`));
      return result as AttachmentReceipt;
    },
    async discardAttachment(id: string): Promise<void> {
      if (!session || connection !== "connected") return;
      await post("/api/attachment/remove", { sessionId: session.sessionId, id });
    },
    async send(text: string, attachments: string[] = []) {
      if (!session || connection !== "connected") return;
      setError("");
      try { await post("/api/message", { sessionId: session.sessionId, text, attachments }); }
      catch (cause) { setError(cause instanceof Error ? cause.message : t("发送失败", "Send failed")); throw cause; }
    },
    async loadMessageImage(messageId: string, index: number): Promise<Blob> {
      if (!session || connection !== "connected") throw new Error(t("Pi 会话不可用", "Pi session is unavailable"));
      const url = `/api/image?sessionId=${encodeURIComponent(session.sessionId)}&messageId=${encodeURIComponent(messageId)}&index=${index}`;
      const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error(t("图片读取失败", "Could not load image"));
      return response.blob();
    },
    async stop() {
      if (!session || connection !== "connected") return;
      try { await post("/api/abort", { sessionId: session.sessionId }); setError(""); }
      catch (cause) { setError(cause instanceof Error ? cause.message : t("停止失败", "Could not stop")); throw cause; }
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
    async getRunningVersion() { return get<{ current: string | null }>("/api/update/version"); },
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
