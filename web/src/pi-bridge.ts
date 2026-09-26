import { useEffect, useState } from "react";

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
export type LoginMethod = "api_key" | "oauth";
export interface ProviderView { id: string; name: string; configured: boolean; methods: LoginMethod[] }
export interface CustomProviderInput { id: string; name: string; baseUrl: string; api: "openai-completions" | "openai-responses" | "anthropic-messages"; modelId: string }
export type LoginPrompt =
  | { type: "text" | "secret" | "manual_code"; message: string; placeholder?: string }
  | { type: "select"; message: string; options: readonly { id: string; label: string; description?: string }[] };
export type LoginEvent =
  | { type: "info"; message: string; links?: readonly { url: string; label?: string }[] }
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; userCode: string; verificationUri: string }
  | { type: "progress"; message: string };
export interface LoginView { id: string; status: "running" | "waiting" | "done" | "error" | "cancelled"; prompt?: LoginPrompt; event?: LoginEvent; error?: string }

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
  if (!response.ok) throw new Error(result.error || `请求失败：${response.status}`);
  return result;
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `请求失败：${response.status}`);
  return result as T;
}

export function usePiBridge() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [streaming, setStreaming] = useState<ViewMessage | null>(null);
  const [connection, setConnection] = useState<ConnectionState>(token ? "connecting" : "missing-token");
  const [error, setError] = useState("");
  const [models, setModels] = useState<ModelOption[]>([]);
  const [commands, setCommands] = useState<CommandOption[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceListView>({ items: [], activeId: null, sessions: [] });
  const [directoryPickerKind, setDirectoryPickerKind] = useState<DirectoryPickerKind | null>(null);

  useEffect(() => {
    if (!token) {
      setError("请在 Pi 终端输入 /web，打开显示的完整地址。");
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
            throw new Error(response.status === 401 ? "访问令牌无效，请在 Pi 中重新输入 /web。" : "连接 Pi 失败");
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
          throw new Error("Pi 网页连接已关闭");
        } catch (cause) {
          if (!alive) return;
          setConnection("disconnected");
          setError(cause instanceof Error ? cause.message : "连接 Pi 失败");
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
    if (connection !== "connected") return;
    let active = true;
    void get<ModelOption[]>("/api/models").then((items) => { if (active) setModels(items); }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : "无法获取模型列表");
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
    commands,
    workspaces,
    directoryPickerKind,
    async pickDirectory(): Promise<string | null> {
      if (!session || connection !== "connected") throw new Error("Pi 会话不可用");
      const result = await post("/api/directory/pick", { sessionId: session.sessionId });
      return result.path;
    },
    async listDirectory(path?: string, signal?: AbortSignal): Promise<DirectoryListing> {
      if (!session || connection !== "connected") throw new Error("Pi 会话不可用");
      return post("/api/directory/list", { sessionId: session.sessionId, ...(path === undefined ? {} : { path }) }, signal);
    },
    async createDirectory(path: string, name: string): Promise<string> {
      if (!session || connection !== "connected") throw new Error("Pi 会话不可用");
      const result = await post("/api/directory/create", { sessionId: session.sessionId, path, name });
      return result.path;
    },
    clearError: () => setError(""),
    async upload(file: File, signal?: AbortSignal): Promise<AttachmentReceipt> {
      if (!session || connection !== "connected") throw new Error("Pi 会话不可用");
      const url = `/api/attachment?sessionId=${encodeURIComponent(session.sessionId)}&name=${encodeURIComponent(file.name)}`;
      const response = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": file.type || "application/octet-stream" },
        body: file,
        signal,
      });
      const result = await response.json();
      if (response.status === 404) throw new Error("当前 Pi 桥接服务仍是旧版。请在 Pi 中输入 /reload，再输入 /web 并打开新地址，然后重试上传。");
      if (!response.ok) throw new Error(result.error || `上传失败：${response.status}`);
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
      catch (cause) { setError(cause instanceof Error ? cause.message : "发送失败"); throw cause; }
    },
    async loadMessageImage(messageId: string, index: number): Promise<Blob> {
      if (!session || connection !== "connected") throw new Error("Pi 会话不可用");
      const url = `/api/image?sessionId=${encodeURIComponent(session.sessionId)}&messageId=${encodeURIComponent(messageId)}&index=${index}`;
      const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error("图片读取失败");
      return response.blob();
    },
    async stop() {
      if (!session || connection !== "connected") return;
      try { await post("/api/abort", { sessionId: session.sessionId }); setError(""); }
      catch (cause) { setError(cause instanceof Error ? cause.message : "停止失败"); throw cause; }
    },
    async compact() {
      if (!session || connection !== "connected") throw new Error("Pi 会话不可用");
      try { await post("/api/compact", { sessionId: session.sessionId }); setError(""); }
      catch (cause) { setError(cause instanceof Error ? cause.message : "压缩失败"); throw cause; }
    },
    async newSession() {
      if (!session || connection !== "connected") return;
      try { await post("/api/new-session", { sessionId: session.sessionId }); }
      catch (cause) { setError(cause instanceof Error ? cause.message : "无法创建新会话"); throw cause; }
    },
    async addWorkspace(path: string, create: boolean) {
      if (!session || connection !== "connected") throw new Error("Pi 会话不可用");
      await post("/api/workspace/add", { sessionId: session.sessionId, path, create });
    },
    async selectWorkspace(id: string) {
      if (!session || connection !== "connected") throw new Error("Pi 会话不可用");
      await post("/api/workspace/select", { sessionId: session.sessionId, id });
    },
    async newSessionInWorkspace(id: string) {
      if (!session || connection !== "connected") throw new Error("Pi 会话不可用");
      await post("/api/workspace/new-session", { sessionId: session.sessionId, id });
    },
    async removeWorkspace(id: string) {
      if (!session || connection !== "connected") throw new Error("Pi 会话不可用");
      await post("/api/workspace/remove", { sessionId: session.sessionId, id });
    },
    async selectSession(workspaceId: string, id: string, path: string | null) {
      if (!session || connection !== "connected") throw new Error("Pi 会话不可用");
      await post("/api/session/select", { sessionId: session.sessionId, workspaceId, id, path: path ?? "" });
    },
    async setModel(provider: string, id: string) {
      if (!session || connection !== "connected") return;
      try { await post("/api/model", { sessionId: session.sessionId, provider, id }); setError(""); }
      catch (cause) { setError(cause instanceof Error ? cause.message : "切换模型失败"); throw cause; }
    },
    async setThinkingLevel(level: string) {
      if (!session || connection !== "connected") return;
      try { await post("/api/thinking-level", { sessionId: session.sessionId, level }); setError(""); }
      catch (cause) { setError(cause instanceof Error ? cause.message : "切换推理强度失败"); throw cause; }
    },
    async getConfig() { return get<ConfigView>("/api/config"); },
    async getProviders() { return get<ProviderView[]>("/api/providers"); },
    async addCustomProvider(provider: CustomProviderInput): Promise<void> {
      if (!session || connection !== "connected") throw new Error("Pi 会话不可用");
      await post("/api/provider/custom", { sessionId: session.sessionId, provider });
    },
    async startProviderLogin(providerId: string, method: LoginMethod): Promise<{ id: string }> {
      if (!session || connection !== "connected") throw new Error("Pi 会话不可用");
      return post("/api/provider/login", { sessionId: session.sessionId, providerId, method });
    },
    async getProviderLogin(id: string) { return get<LoginView>(`/api/provider/login?id=${encodeURIComponent(id)}`); },
    async respondProviderLogin(id: string, value: string) {
      if (!session || connection !== "connected") throw new Error("Pi 会话不可用");
      await post("/api/provider/login/respond", { sessionId: session.sessionId, id, value });
    },
    async cancelProviderLogin(id: string) {
      if (!session || connection !== "connected") return;
      await post("/api/provider/login/cancel", { sessionId: session.sessionId, id });
    },
    async refreshModels() { setModels(await get<ModelOption[]>("/api/models")); },
    async updateConfig(kind: ConfigKind, scope: ConfigScope, action: "add" | "remove", value: string) {
      if (!session || connection !== "connected") throw new Error("Pi 会话不可用");
      return post("/api/config", { sessionId: session.sessionId, kind, scope, action, value }) as Promise<ConfigView>;
    },
  };
}
