import { randomBytes, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { NodeClient } from "@sentry/node";
import type { BaseTransportOptions, Transport } from "@sentry/core";
import { buildId, release } from "../shared/build-info.ts";
import { boundedFetchTransport, BreadcrumbBuffer, ErrorReporter, privateBeforeSend, privateDataCollection, isExpectedError, sanitizeError, safeFields, type DiagnosticFields, type TelemetryConfig } from "../shared/telemetry.ts";

export const DEFAULT_SENTRY_DSN = "https://070c0b7c5ac18d940c294e63ecfa0793@o4506663318716416.ingest.us.sentry.io/4512191040716800";

export function readTelemetryConfig(env: Record<string, string | undefined> = process.env, warn: (message: string) => void = console.warn): { browser: TelemetryConfig; node: TelemetryConfig } {
  const config = (side: "BROWSER" | "NODE"): TelemetryConfig => {
    const base = { enabled: false, environment: env.PI_WEB_SENTRY_ENVIRONMENT || "production", release, buildId };
    const dsn = env[`PI_WEB_SENTRY_${side}_DSN`] ?? env.PI_WEB_SENTRY_DSN ?? DEFAULT_SENTRY_DSN;
    if (env.PI_WEB_SENTRY_ENABLED === "false" || !dsn) return base;
    try {
      const url = new URL(dsn);
      if (url.protocol !== "https:" || !/^[\w-]+$/.test(url.username) || url.password || url.search || url.hash || !/\/(?:[\w-]+\/)*\d+$/.test(url.pathname)) throw new Error();
      return { ...base, enabled: true, dsn };
    } catch { warn(`pi-webapp: invalid ${side.toLowerCase()} Sentry DSN; error reporting disabled for this side.`); return base; }
  };
  return { browser: config("BROWSER"), node: config("NODE") };
}

export class NodeTelemetry {
  readonly config: ReturnType<typeof readTelemetryConfig>;
  readonly ready: Promise<void>;
  reporter?: ErrorReporter;
  private client?: NodeClient;
  private readonly salt = randomBytes(16);
  private readonly breadcrumbs = new BreadcrumbBuffer();
  private readonly seen = new WeakSet<object>();
  private early: Array<{ error: Error; context: DiagnosticFields; eventId: string }> = [];
  private state: DiagnosticFields = { nodeVersion: process.version, platform: process.platform };
  private fatal?: (error: Error) => void;
  private closed = false;
  private failed = false;
  get enabled(): boolean { return this.config.node.enabled && !this.closed && !this.failed; }
  constructor(options: { env?: Record<string, string | undefined>; transport?: (options: BaseTransportOptions) => Transport; monitor?: boolean } = {}) {
    this.config = readTelemetryConfig(options.env);
    if (!this.config.node.enabled) { this.ready = Promise.resolve(); return; }
    if (options.monitor !== false) {
      const filename = fileURLToPath(import.meta.url).replace(/\\/g, "/");
      const extensionRoot = filename.slice(0, filename.lastIndexOf("/") + 1);
      this.fatal = (error) => {
        if (error.stack?.replace(/\\/g, "/").includes(filename.endsWith("extension.js") ? filename : extensionRoot)) this.capture(error, { stage: "fatal" });
      };
      process.on("uncaughtExceptionMonitor", this.fatal);
    }
    this.ready = import("@sentry/node").then((sdk) => {
      if (this.closed) return;
      this.client = new sdk.NodeClient({
        ...this.config.node, dist: buildId, integrations: [], transport: options.transport ?? ((options) => boundedFetchTransport(sdk.createTransport, options)),
        stackParser: sdk.defaultStackParser, beforeSend: privateBeforeSend, sendClientReports: false,
        dataCollection: { ...privateDataCollection, httpBodies: [] },
        includeServerName: false, enableRuntimeChannelInjection: false,
        beforeSendLog: () => null, beforeSendMetric: () => null,
        enableOpenTelemetrySetup: false, maxBreadcrumbs: 100,
      });
      // NodeClient.init() changes the host's async-context strategy; use explicit bound Scopes instead.
      this.reporter = new ErrorReporter(this.client, "node", buildId, sdk, this.breadcrumbs);
      this.reporter.setState(this.state);
      for (const item of this.early) this.reporter.capture(item.error, item.context, item.eventId);
    }).catch(() => {
      this.failed = true;
      console.warn("pi-webapp: Sentry initialization failed; error reporting disabled.");
    }).finally(() => { this.early = []; });
  }
  capture(cause: unknown, context: DiagnosticFields = {}): string | undefined {
    try {
      if (!this.enabled || isExpectedError(cause)) return;
      if (typeof cause === "object" && cause !== null) {
        if (this.seen.has(cause)) return;
        this.seen.add(cause);
      }
      if (this.reporter) return this.reporter.capture(cause, context);
      if (this.early.length >= 20) return;
      const eventId = randomBytes(16).toString("hex");
      this.early.push({ error: sanitizeError(cause), context: safeFields(context), eventId });
      return eventId;
    } catch { return; }
  }
  setState(state: DiagnosticFields): void { this.state = safeFields({ ...this.state, ...state }); this.reporter?.setState(this.state); }
  breadcrumb(category: string, context: DiagnosticFields = {}): void { if (this.enabled) this.breadcrumbs.add(category, context); }
  session(id: string): string { return createHash("sha256").update(this.salt).update(id).digest("hex").slice(0, 16); }
  async flush(timeoutMs = 3000): Promise<boolean> {
    await this.ready;
    try { return this.enabled && !!await this.client?.flush(timeoutMs); } catch { return false; }
  }
  async close(): Promise<void> {
    const started = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([this.ready, new Promise<void>((resolve) => { timer = setTimeout(resolve, 500); })]); }
    finally { clearTimeout(timer); this.closed = true; if (this.fatal) process.off("uncaughtExceptionMonitor", this.fatal); }
    try { await this.client?.close(Math.max(1, 500 - (performance.now() - started))); } catch { /* Do not affect shutdown. */ }
  }
}
