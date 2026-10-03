import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { SessionView, ViewMessage } from "./view.ts";
import type { WorkspaceView } from "./workspaces.ts";
import { createDirectory, listDirectory } from "./directory-picker.ts";
import { directoryPickerKind, pickNativeDirectory } from "./native-directory-picker.ts";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, imageContent, saveAttachment, type UploadedAttachment } from "./attachments.ts";
import type { ResourceItem } from "./config-inventory.ts";
import { ProviderLoginController, type LoginMethod, type ProviderView } from "./provider-login.ts";
import { validCustomProviderInput, type CustomProviderInput } from "./custom-provider.ts";
import { validModelChange, type ModelChange, type ProviderModelsView } from "./provider-model-config.ts";
import { isPackageSource } from "../shared/config-source.ts";
import type { SelfUpdater } from "./self-update.ts";
import type { WebPluginCatalogView } from "./web-plugins.ts";
import { NodeTelemetry } from "./telemetry.ts";
import { isExpectedError, isContentOperation, opaqueError, type DiagnosticFields, type ErrorCorrelation } from "../shared/telemetry.ts";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { buildId } from "../shared/build-info.ts";
import { readAssetManifest } from "./web-assets.ts";

export interface WorkspaceSessionView { id: string; workspaceId: string; path: string | null; name: string; modified: string }
export interface WorkspaceListView { items: WorkspaceView[]; activeId: string | null; sessions: WorkspaceSessionView[] }

export interface BridgeHost {
  plugins?(): WebPluginCatalogView | Promise<WebPluginCatalogView>;
  pluginAsset?(path: string): Promise<{ bytes: Buffer; type: string } | null>;
  invokePluginAction?(sessionId: string, pluginId: string, action: string, input: unknown): Promise<unknown>;
  selfUpdate?: Pick<SelfUpdater, "check" | "runningVersion" | "prepare" | "requestRestart">;
  resolvePluginInteraction?(sessionId: string, pluginId: string, requestId: string, value: unknown): Promise<void>;
  snapshot(): SessionView;
  image?(sessionId: string, messageId: string, index: number): { data: Buffer; mimeType: string } | null;
  models(): Array<{ provider: string; id: string; name: string }> | Promise<Array<{ provider: string; id: string; name: string }>>;
  providers?(): Promise<ProviderView[]>;
  providerModels?(providerId: string): Promise<ProviderModelsView>;
  updateProviderModel?(sessionId: string, providerId: string, change: ModelChange): Promise<void>;
  logoutProvider?(sessionId: string, providerId: string): Promise<void>;
  loginProvider?(providerId: string, method: LoginMethod, interaction: import("@earendil-works/pi-ai").AuthInteraction): Promise<void>;
  addCustomProvider?(sessionId: string, input: CustomProviderInput): Promise<void>;
  commands?(): Array<{ name: string; description?: string }>;
  compact?(sessionId: string): void | Promise<void>;
  setModel(sessionId: string, provider: string, id: string): Promise<void>;
  setThinkingLevel(sessionId: string, level: string): Promise<void>;
  config(): ConfigView | Promise<ConfigView>;
  updateConfig(change: ConfigChange): Promise<ConfigView>;
  send(sessionId: string, text: string, images?: Array<{ type: "image"; data: string; mimeType: string }>, correlation?: ErrorCorrelation): void | Promise<void>;
  abort(sessionId: string): void | Promise<void>;
  resume?(sessionId: string, correlation?: ErrorCorrelation): void | Promise<void>;
  newSession(sessionId: string): Promise<void>;
  workspaces(): Promise<WorkspaceListView>;
  addWorkspace(path: string, create: boolean): Promise<void>;
  selectWorkspace(id: string): Promise<void>;
  newSessionInWorkspace(id: string): Promise<void>;
  removeWorkspace(id: string): Promise<void>;
  selectSession(workspaceId: string, id: string, path: string): Promise<void>;
}

export type ConfigKind = "packages" | "extensions" | "skills";
export type ConfigScope = "global" | "project";
export interface ConfigView {
  projectTrusted: boolean;
  global: Record<ConfigKind, string[]>;
  project: Record<ConfigKind, string[]>;
  installed: Record<ConfigKind, ResourceItem[]>;
}
export interface ConfigChange {
  sessionId: string;
  kind: ConfigKind;
  scope: ConfigScope;
  action: "add" | "remove";
  value: string;
}

export type BridgeEvent = { type: "shutdown"; reconnect?: boolean } | { type: "plugins_changed" } | { type: "snapshot"; session: SessionView } | { type: "stream"; message: ViewMessage | null } | { type: "workspaces"; value: WorkspaceListView } | ({ type: "error"; message: string; errorCode?: string; errorReported?: boolean } & ErrorCorrelation);

export interface Bridge {
  readonly protocolVersion: 7;
  readonly buildId: string;
  readonly url: string;
  publish(event: BridgeEvent): void;
  reportError(cause: unknown, context?: DiagnosticFields): string | undefined;
  breadcrumb(category: string, context?: DiagnosticFields): void;
  close(options?: { reconnect?: boolean }): Promise<void>;
}

const files: Record<string, { path: string; type: string }> = {
  "/": { path: "index.html", type: "text/html; charset=utf-8" },
  "/assets/app.js": { path: "assets/app.js", type: "text/javascript; charset=utf-8" },
  "/assets/style.css": { path: "assets/style.css", type: "text/css; charset=utf-8" },
};

function json(res: ServerResponse, status: number, body: unknown): void {
  if (typeof body === "object" && body !== null && "error" in body) body = {
    errorCode: status >= 500 ? "server_error" : "validation_error", ...body,
    requestId: res.getHeader("X-Request-ID"), operationId: res.getHeader("X-Operation-ID"),
  };
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function authorized(req: IncomingMessage, token: Buffer): boolean {
  const candidate = req.headers.authorization;
  if (typeof candidate !== "string" || !candidate.startsWith("Bearer ")) return false;
  const presented = Buffer.from(candidate.slice(7), "utf8");
  return presented.length === token.length && timingSafeEqual(presented, token);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 64 * 1024) throw new Error("请求内容过大");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function readAttachment(req: IncomingMessage): Promise<Buffer> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_ATTACHMENT_BYTES) throw new Error("文件超过 20 MB");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

async function listen(server: Server, requestedPort = 0): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("无法确定监听端口");
  return address.port;
}

export async function startBridge(host: BridgeHost, webRoot: string, telemetry = new NodeTelemetry()): Promise<Bridge> {
  telemetry.setState({ piVersion: VERSION });
  const fixedToken = process.env.PI_WEBAPP_RESTART_TOKEN;
  const tokenText = fixedToken && /^[A-Za-z0-9_-]{32}$/.test(fixedToken) ? fixedToken : randomBytes(24).toString("base64url");
  const token = Buffer.from(tokenText);
  const pickerKind = directoryPickerKind();
  const streams = new Set<ServerResponse>();
  const attachments = new Map<string, UploadedAttachment>();
  const logins = new ProviderLoginController((cause, context) => telemetry.capture(cause, context));
  const remember = (session: SessionView) => telemetry.setState({ nodeVersion: process.version, platform: process.platform, session: telemetry.session(session.sessionId), idle: session.idle, model: session.model, thinkingLevel: session.thinkingLevel, messageCount: session.messages.length });
  let origin = "";
  let restarting = false;
  // DSH Markdown loads language grammars and KaTeX fonts lazily. Only files
  // inventoried from the compiled assets directory can be served here.
  const assets = { ...files, ...await readAssetManifest(webRoot) };
  for (const name of await readdir(join(webRoot, "assets")).catch(() => [])) {
    const match = /^[\w.-]+\.(js|css|woff2?|ttf)$/.exec(name);
    if (!match) continue;
    const mime: Record<string, string> = { js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf" };
    assets[`/assets/${name}`] = { path: `assets/${name}`, type: mime[match[1]!]! };
  }
  const server = createServer(async (req, res) => {
    const validId = (id: unknown): id is string => typeof id === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id);
    const requestId = validId(req.headers["x-request-id"]) ? req.headers["x-request-id"] : randomUUID();
    const correlation = { requestId, operationId: validId(req.headers["x-operation-id"]) ? req.headers["x-operation-id"] : undefined };
    res.setHeader("X-Request-ID", requestId);
    if (correlation.operationId) res.setHeader("X-Operation-ID", correlation.operationId);
    let path = "/";
    const started = performance.now();
    const fail = (cause: unknown, status: number, message: string) => {
      const expected = isExpectedError(cause);
      const diagnostic = !expected && isContentOperation(path) ? opaqueError(cause, "Agent or provider operation failed") : cause;
      const errorId = telemetry.capture(diagnostic, { ...correlation, route: path, method: req.method, status, stage: "http" });
      json(res, status, { error: message, errorId, errorReported: telemetry.enabled, errorCode: isExpectedError(cause) ? "validation_error" : "unexpected_error" });
    };
    res.once("finish", () => {
      if (!path.startsWith("/api/telemetry/")) telemetry.breadcrumb("request", { ...correlation, route: path, method: req.method, status: res.statusCode, durationMs: Math.round(performance.now() - started) });
    });
    try {
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Content-Security-Policy", `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'${telemetry.config.browser.dsn ? ` ${new URL(telemetry.config.browser.dsn).origin}` : ""}; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`);
      try {
        path = new URL(req.url ?? "/", origin).pathname;
      } catch {
        json(res, 400, { error: "请求地址无效" });
        return;
      }
      const asset = assets[path];
      if (req.method === "GET" && asset) {
        try {
          const bytes = await readFile(join(webRoot, asset.path));
          res.writeHead(200, { "Content-Type": asset.type, "Cache-Control": "no-store" });
          res.end(bytes);
        } catch (cause) {
          fail(cause, 500, "页面文件不可用");
        }
        return;
      }
      if (req.method === "GET" && path.startsWith("/plugins/")) {
        try {
          const pluginAsset = await host.pluginAsset?.(req.url ?? path);
          if (!pluginAsset) { json(res, 404, { error: "插件资源不存在" }); return; }
          res.writeHead(200, { "Content-Type": pluginAsset.type, "Cache-Control": "no-store" });
          res.end(pluginAsset.bytes);
        } catch (cause) { fail(cause, 404, "插件资源不可用"); }
        return;
      }
      if (!path.startsWith("/api/")) {
        json(res, 404, { error: "未找到" });
        return;
      }
      if (!authorized(req, token)) {
        json(res, 401, { error: "访问令牌无效" });
        return;
      }
      if (req.method === "GET" && path === "/api/telemetry/config") {
        json(res, 200, telemetry.config.browser); return;
      }
      if (req.method === "GET" && path === "/api/update/version") {
        try { json(res, 200, { current: await host.selfUpdate?.runningVersion() ?? null }); }
        catch (error) { fail(error, 503, error instanceof Error ? error.message : "无法读取版本"); }
        return;
      }
      if (req.method === "GET" && path === "/api/update") {
        try { json(res, 200, await host.selfUpdate?.check() ?? { canRestart: false, reason: "当前扩展不支持在线升级" }); }
        catch (error) { fail(error, 503, error instanceof Error ? error.message : "检查更新失败"); }
        return;
      }
      if (req.method === "GET" && path === "/api/image") {
        const url = new URL(req.url ?? path, origin);
        const sessionId = url.searchParams.get("sessionId") ?? "";
        const messageId = url.searchParams.get("messageId") ?? "";
        const index = Number(url.searchParams.get("index"));
        if (!sessionId || sessionId !== host.snapshot().sessionId || !messageId || !Number.isInteger(index) || index < 0 || index > 100) {
          json(res, 409, { error: "会话已切换或图片地址无效" }); return;
        }
        const image = host.image?.(sessionId, messageId, index);
        if (!image || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(image.mimeType)) {
          json(res, 404, { error: "图片不可用" }); return;
        }
        res.writeHead(200, { "Content-Type": image.mimeType, "Cache-Control": "private, no-store" });
        res.end(image.data);
        return;
      }
      if (req.method === "POST" && path === "/api/attachment") {
        if (req.headers.origin !== undefined && req.headers.origin !== origin) { json(res, 403, { error: "来源不匹配" }); return; }
        const url = new URL(req.url ?? path, origin);
        const sessionId = url.searchParams.get("sessionId");
        const name = url.searchParams.get("name");
        try {
          if (!sessionId || !name || name.length > 1024 || sessionId !== host.snapshot().sessionId) {
            json(res, 409, { error: "会话已切换或文件名无效" }); return;
          }
          if (Number(req.headers["content-length"] ?? 0) > MAX_ATTACHMENT_BYTES) { json(res, 413, { error: "文件超过 20 MB" }); return; }
          const attachment = await saveAttachment(sessionId, name, req.headers["content-type"] ?? "application/octet-stream", await readAttachment(req));
          if (sessionId !== host.snapshot().sessionId) { json(res, 409, { error: "会话已切换" }); return; }
          attachments.set(attachment.id, attachment);
          json(res, 201, { id: attachment.id, name: attachment.name, bytes: attachment.bytes });
        } catch (error) {
          fail(error, 400, error instanceof Error ? error.message : "上传失败");
        }
        return;
      }
      if (req.method === "GET" && path === "/api/session") {
        try {
          const session = host.snapshot();
          remember(session);
          json(res, 200, session);
        } catch (cause) {
          fail(cause, 503, "当前会话不可用");
        }
        return;
      }
      if (req.method === "GET" && path === "/api/plugins") {
        try { json(res, 200, await host.plugins?.() ?? { plugins: [], errors: [] }); }
        catch (cause) { fail(cause, 503, "插件目录不可用"); }
        return;
      }
      if (req.method === "GET" && path === "/api/providers") {
        try { json(res, 200, await host.providers?.() ?? []); }
        catch (cause) { fail(cause, 503, "模型提供方不可用"); }
        return;
      }
      if (req.method === "GET" && path === "/api/provider/models") {
        const providerId = new URL(req.url ?? path, origin).searchParams.get("providerId") ?? "";
        try {
          if (!providerId || !host.providerModels) { json(res, 400, { error: "提供方无效" }); return; }
          json(res, 200, await host.providerModels(providerId));
        } catch (error) { fail(error, 400, error instanceof Error ? error.message : "模型目录不可用"); }
        return;
      }
      if (req.method === "GET" && path === "/api/provider/login/active") {
        json(res, 200, { active: logins.getActive() ?? null });
        return;
      }
      if (req.method === "GET" && path === "/api/provider/login") {
        const id = new URL(req.url ?? path, origin).searchParams.get("id") ?? "";
        const view = logins.get(id);
        json(res, view ? 200 : 404, view ?? { error: "登录流程不存在" });
        return;
      }
      if (req.method === "GET" && (path === "/api/models" || path === "/api/config" || path === "/api/workspaces" || path === "/api/commands")) {
        try { json(res, 200, path === "/api/models" ? await host.models() : path === "/api/config" ? await host.config() : path === "/api/commands" ? host.commands?.() ?? [] : await host.workspaces()); }
        catch (cause) { fail(cause, 503, "Pi 配置不可用"); }
        return;
      }
      if (req.method === "GET" && path === "/api/directory/capability") {
        json(res, 200, { kind: pickerKind }); return;
      }
      if (req.method === "GET" && path === "/api/events") {
        let initial: SessionView;
        try {
          initial = host.snapshot();
          remember(initial);
        } catch (cause) {
          fail(cause, 503, "当前会话不可用");
          return;
        }
        res.writeHead(200, {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        streams.add(res);
        res.write(`${JSON.stringify({ type: "snapshot", session: initial })}\n`);
        res.on("close", () => streams.delete(res));
        return;
      }
      if (req.method === "POST" && ["/api/plugin-interaction", "/api/plugin-action", "/api/update", "/api/message", "/api/attachment/remove", "/api/abort", "/api/resume", "/api/compact", "/api/new-session", "/api/model", "/api/thinking-level", "/api/config", "/api/provider/login", "/api/provider/login/respond", "/api/provider/login/cancel", "/api/provider/custom", "/api/provider/models", "/api/provider/logout", "/api/workspace/add", "/api/workspace/select", "/api/workspace/new-session", "/api/workspace/remove", "/api/session/select", "/api/directory/list", "/api/directory/create", "/api/directory/pick"].includes(path)) {
        if (req.headers.origin !== undefined && req.headers.origin !== origin) {
          json(res, 403, { error: "来源不匹配" });
          return;
        }
        if (!req.headers["content-type"]?.startsWith("application/json")) {
          json(res, 415, { error: "需要 JSON 请求" });
          return;
        }
        try {
          let body: unknown;
          try { body = await readJson(req); } catch (cause) {
            if (cause instanceof SyntaxError || isExpectedError(cause)) { json(res, 400, { error: "请求内容无效" }); return; }
            throw cause;
          }
          if (typeof body !== "object" || body === null || !("sessionId" in body) || typeof body.sessionId !== "string") {
            json(res, 400, { error: "缺少会话标识" });
            return;
          }
          if (path === "/api/plugin-interaction") {
            if (body.sessionId !== host.snapshot().sessionId) { json(res, 409, { error: "会话已切换" }); return; }
            if (!("pluginId" in body) || typeof body.pluginId !== "string" || body.pluginId.length > 200 || !("requestId" in body) || typeof body.requestId !== "string" || body.requestId.length > 200 || !host.resolvePluginInteraction || !("value" in body)) {
              json(res, 400, { error: "插件交互响应无效" }); return;
            }
            await host.resolvePluginInteraction(body.sessionId, body.pluginId, body.requestId, body.value);
            json(res, 200, { accepted: true });
            return;
          }
          if (path === "/api/plugin-action") {
            if (body.sessionId !== host.snapshot().sessionId) { json(res, 409, { error: "会话已切换" }); return; }
            if (!("pluginId" in body) || typeof body.pluginId !== "string" || body.pluginId.length > 200 || !("action" in body) || typeof body.action !== "string" || body.action.length > 100 || !host.invokePluginAction) {
              json(res, 400, { error: "插件动作无效" }); return;
            }
            const value = await host.invokePluginAction(body.sessionId, body.pluginId, body.action, "input" in body ? body.input : undefined);
            json(res, 200, { value });
            return;
          }
          if (path === "/api/update") {
            if (body.sessionId !== host.snapshot().sessionId) { json(res, 409, { error: "会话已切换" }); return; }
            if (!host.snapshot().idle) { json(res, 409, { error: "请等待当前回复结束后再升级" }); return; }
            if (!host.selfUpdate) { json(res, 409, { error: "当前扩展不支持在线升级" }); return; }
            const prepared = await host.selfUpdate.prepare();
            restarting = true;
            json(res, 202, { accepted: true, version: prepared.version });
            setTimeout(() => { void host.selfUpdate?.requestRestart(prepared).catch((error) => { restarting = false; telemetry.capture(error, { stage: "restart" }); console.error("pi-webapp restart:", error); }); }, 500).unref();
            return;
          }
          if (path === "/api/provider/custom") {
            if (body.sessionId !== host.snapshot().sessionId) { json(res, 409, { error: "会话已切换" }); return; }
            if (!("provider" in body) || !validCustomProviderInput(body.provider) || !host.addCustomProvider) { json(res, 400, { error: "自定义提供方无效" }); return; }
            await host.addCustomProvider(body.sessionId, body.provider);
            json(res, 201, { accepted: true }); return;
          }
          if (path === "/api/provider/models" || path === "/api/provider/logout") {
            if (body.sessionId !== host.snapshot().sessionId) { json(res, 409, { error: "会话已切换" }); return; }
            if (!("providerId" in body) || typeof body.providerId !== "string") { json(res, 400, { error: "提供方无效" }); return; }
            if (path === "/api/provider/models") {
              if (!("change" in body) || !validModelChange(body.change) || !host.updateProviderModel) { json(res, 400, { error: "模型参数无效" }); return; }
              await host.updateProviderModel(body.sessionId, body.providerId, body.change);
            } else {
              if (!host.logoutProvider) { json(res, 400, { error: "无法移除认证" }); return; }
              await host.logoutProvider(body.sessionId, body.providerId);
            }
            json(res, 200, { accepted: true }); return;
          }
          if (path.startsWith("/api/provider/login")) {
            if (body.sessionId !== host.snapshot().sessionId) { json(res, 409, { error: "会话已切换" }); return; }
            if (path === "/api/provider/login") {
              if (!("providerId" in body) || typeof body.providerId !== "string" || !("method" in body) || (body.method !== "api_key" && body.method !== "oauth") || !host.loginProvider || !host.providers) {
                json(res, 400, { error: "登录方式无效" }); return;
              }
              const providers = await host.providers();
              if (!providers.some((item) => item.id === body.providerId && item.methods.includes(body.method as LoginMethod))) { json(res, 400, { error: "提供方不支持此登录方式" }); return; }
              const initialSecret = "initialSecret" in body ? body.initialSecret : undefined;
              if (initialSecret !== undefined && (body.method !== "api_key" || typeof initialSecret !== "string" || !initialSecret.trim() || initialSecret.length > 16384)) { json(res, 400, { error: "API Key 无效" }); return; }
              const view = logins.start(body.providerId, body.method as LoginMethod, host.loginProvider, initialSecret, correlation);
              json(res, 202, { id: view.id }); return;
            }
            if (!("id" in body) || typeof body.id !== "string") { json(res, 400, { error: "登录流程无效" }); return; }
            if (path === "/api/provider/login/cancel") { json(res, logins.cancel(body.id) ? 202 : 404, { accepted: true }); return; }
            if (!("value" in body) || typeof body.value !== "string" || body.value.length > 16384 || !logins.respond(body.id, body.value)) { json(res, 400, { error: "登录输入无效" }); return; }
            json(res, 202, { accepted: true }); return;
          }
          if (path === "/api/attachment/remove") {
            if (!("id" in body) || typeof body.id !== "string" || body.sessionId !== host.snapshot().sessionId) { json(res, 409, { error: "会话已切换或附件无效" }); return; }
            const attachment = attachments.get(body.id);
            if (attachment?.sessionId === body.sessionId) attachments.delete(body.id);
            json(res, 202, { accepted: true }); return;
          }
          if (path === "/api/directory/pick") {
            if (pickerKind !== "native") { json(res, 409, { error: "本地目录选择器不可用" }); return; }
            const controller = new AbortController();
            res.once("close", () => controller.abort());
            json(res, 200, { path: await pickNativeDirectory(controller.signal) }); return;
          }
          if (path === "/api/directory/list") {
            if ("path" in body && (typeof body.path !== "string" || body.path.length > 4096)) {
              json(res, 400, { error: "目录路径无效" }); return;
            }
            json(res, 200, await listDirectory("path" in body ? body.path as string : undefined)); return;
          }
          if (path === "/api/directory/create") {
            if (!("path" in body) || typeof body.path !== "string" || body.path.length > 4096
              || !("name" in body) || typeof body.name !== "string" || body.name.length > 255) {
              json(res, 400, { error: "文件夹名称或路径无效" }); return;
            }
            json(res, 200, { path: await createDirectory(body.path, body.name) }); return;
          }
          if (path === "/api/workspace/add") {
            if (!("path" in body) || typeof body.path !== "string" || body.path.length > 4096 || !("create" in body) || typeof body.create !== "boolean") {
              json(res, 400, { error: "工作区路径无效" }); return;
            }
            await host.addWorkspace(body.path, body.create);
            json(res, 202, { accepted: true }); return;
          }
          if (path === "/api/workspace/select" || path === "/api/workspace/remove" || path === "/api/workspace/new-session") {
            if (!("id" in body) || typeof body.id !== "string") { json(res, 400, { error: "工作区无效" }); return; }
            if (path === "/api/workspace/select") await host.selectWorkspace(body.id);
            else if (path === "/api/workspace/new-session") await host.newSessionInWorkspace(body.id);
            else await host.removeWorkspace(body.id);
            json(res, 202, { accepted: true }); return;
          }
          if (path === "/api/session/select") {
            if (!("workspaceId" in body) || typeof body.workspaceId !== "string" || !("id" in body) || typeof body.id !== "string" || !("path" in body) || typeof body.path !== "string") {
              json(res, 400, { error: "会话无效" }); return;
            }
            await host.selectSession(body.workspaceId, body.id, body.path);
            json(res, 202, { accepted: true }); return;
          }
          if (path === "/api/thinking-level") {
            if (!("level" in body) || typeof body.level !== "string") { json(res, 400, { error: "推理强度无效" }); return; }
            await host.setThinkingLevel(body.sessionId, body.level);
          } else if (path === "/api/model") {
            if (!("provider" in body) || typeof body.provider !== "string" || !("id" in body) || typeof body.id !== "string") {
              json(res, 400, { error: "模型无效" }); return;
            }
            await host.setModel(body.sessionId, body.provider, body.id);
          } else if (path === "/api/config") {
            const change = body as Partial<ConfigChange>;
            if (!(["packages", "extensions", "skills"] as unknown[]).includes(change.kind)
              || !(["global", "project"] as unknown[]).includes(change.scope)
              || !(["add", "remove"] as unknown[]).includes(change.action)
              || typeof change.value !== "string" || !change.value.trim() || change.value.length > 2048) {
              json(res, 400, { error: "配置项无效" }); return;
            }
            if (change.action === "add" && change.kind !== "packages" && isPackageSource(change.value)) {
              json(res, 400, { error: "npm 或 Git 来源请在「包」中添加；扩展和技能只接受文件或目录路径" }); return;
            }
            json(res, 200, await host.updateConfig(change as ConfigChange)); return;
          } else if (path === "/api/message") {
            const ids = "attachments" in body ? body.attachments : [];
            if (!Array.isArray(ids) || ids.length > MAX_ATTACHMENTS || ids.some((id) => typeof id !== "string") || new Set(ids).size !== ids.length) {
              json(res, 400, { error: "附件无效或过多" }); return;
            }
            const selected = ids.map((id: string) => attachments.get(id));
            if (selected.some((attachment) => !attachment || attachment.sessionId !== body.sessionId)) {
              json(res, 400, { error: "附件不可用" }); return;
            }
            if (!("text" in body) || typeof body.text !== "string" || (!body.text.trim() && ids.length === 0) || body.text.length > 32_000) {
              json(res, 400, { error: "消息无效或过长" });
              return;
            }
            const files = selected as UploadedAttachment[];
            const text = [body.text.trim(), ...files.map((file) => `附件 ${JSON.stringify(file.name)}：${file.path}`)].filter(Boolean).join("\n\n");
            const images = await Promise.all(files.filter((file) => ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.mediaType)).map(imageContent));
            correlation.operationId ??= randomUUID();
            res.setHeader("X-Operation-ID", correlation.operationId);
            telemetry.breadcrumb("send", { ...correlation, attachmentCount: files.length });
            await host.send(body.sessionId, text, images, correlation);
            for (const id of ids) attachments.delete(id);
          } else if (path === "/api/compact") {
            if (!host.compact) throw new Error("当前会话不支持压缩");
            await host.compact(body.sessionId);
          } else if (path === "/api/resume") {
            const session = host.snapshot();
            if (body.sessionId !== session.sessionId) { json(res, 409, { error: "会话已切换" }); return; }
            if (!session.idle) { json(res, 409, { error: "Pi 正在运行，请等待当前回复结束" }); return; }
            if (!session.paused) { json(res, 409, { error: "当前会话没有暂停的任务" }); return; }
            if (session.interactions?.length) { json(res, 409, { error: "请先完成当前交互或审批" }); return; }
            if (!host.resume) throw new Error("当前服务不支持继续，请重载 Pi");
            correlation.operationId ??= randomUUID();
            res.setHeader("X-Operation-ID", correlation.operationId);
            telemetry.breadcrumb("resume", { ...correlation });
            await host.resume(body.sessionId, correlation);
          } else if (path === "/api/abort") {
            await host.abort(body.sessionId);
          } else {
            await host.newSession(body.sessionId);
          }
          json(res, 202, { accepted: true });
        } catch (error) {
          const message = error instanceof Error ? error.message : "请求失败";
          fail(error, message === "会话已切换" ? 409 : 400, message);
        }
        return;
      }
      json(res, 404, { error: "未找到" });
    } catch (cause) {
      if (!res.headersSent) fail(cause, 500, "请求失败");
      else { telemetry.capture(cause, { ...correlation, route: path, stage: "http_stream" }); res.end(); }
    }
  });
  const requestedPort = Number(process.env.PI_WEBAPP_RESTART_PORT);
  let port: number;
  try { port = await listen(server, Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort < 65536 && fixedToken === tokenText ? requestedPort : 0); }
  catch (cause) { telemetry.capture(cause, { stage: "listen" }); await telemetry.close(); throw cause; }
  origin = `http://127.0.0.1:${port}`;
  return {
    protocolVersion: 7,
    buildId,
    reportError(cause, context) { return telemetry.capture(cause, context); },
    breadcrumb(category, context) { telemetry.breadcrumb(category, context); },
    url: `${origin}/#${tokenText}`,
    publish(event) {
      if (event.type === "snapshot") remember(event.session);
      if (event.type === "error" && !event.errorCode) event = { ...event, errorCode: "unexpected_error", errorId: telemetry.capture(new Error("Agent execution failed"), { stage: "agent", requestId: event.requestId, operationId: event.operationId }) };
      if (event.type === "error") event = { ...event, errorReported: event.errorReported ?? telemetry.enabled };
      if (event.type === "snapshot") for (const [id, attachment] of attachments) if (attachment.sessionId !== event.session.sessionId) attachments.delete(id);
      const line = `${JSON.stringify(event)}\n`;
      for (const stream of streams) stream.write(line);
    },
    async close(options) {
      logins.close();
      for (const stream of streams) stream.end(`${JSON.stringify({ type: "shutdown", reconnect: options?.reconnect ?? restarting })}\n`);
      streams.clear();
      let force: ReturnType<typeof setTimeout> | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
          // Cancelled browser streams can leave half-open sockets which otherwise block /reload.
          force = setTimeout(() => server.closeAllConnections(), 50).unref();
        });
      } finally { clearTimeout(force); await telemetry.close(); }
    },
  };
}
