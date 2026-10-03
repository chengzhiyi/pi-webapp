import { isExpectedError, sanitizeError, safeFields, type ErrorReporter, type DiagnosticFields, type TelemetryConfig } from "../../shared/telemetry.ts";
import { accessToken } from "./access-token.ts";
import { buildId, release } from "../../shared/build-info.ts";

let reporter: ErrorReporter | undefined;
let pending = true;
let installed = false;
let early: Array<{ error: Error; context: DiagnosticFields }> = [];
const observed = new WeakSet<object>();
const sessions = new Map<string, string>();
let state: DiagnosticFields = {};

export function reportError(cause: unknown, context: DiagnosticFields = {}): string | undefined {
  try {
    if (isExpectedError(cause)) return;
    if (typeof cause === "object" && cause !== null) {
      if (observed.has(cause)) return;
      observed.add(cause);
    }
    if (reporter) return reporter.capture(cause, context);
    if (pending && early.length < 20) early.push({ error: sanitizeError(cause), context: safeFields(context) });
  } catch { /* Telemetry is never part of the application failure path. */ }
}

export function ignoreError(cause: object): void { observed.add(cause); }
export function breadcrumb(category: string, context: DiagnosticFields = {}): void { reporter?.breadcrumbs.add(category, context); }
export function setTelemetryState(next: DiagnosticFields & { sessionId?: string }): void {
  if (next.sessionId) {
    if (!sessions.has(next.sessionId)) {
      if (sessions.size >= 32) sessions.delete(sessions.keys().next().value!);
      sessions.set(next.sessionId, crypto.randomUUID());
    }
    next = { ...next, session: sessions.get(next.sessionId) };
  }
  state = safeFields({ ...state, ...next });
  reporter?.setState(state);
}

export function installBrowserTelemetry(): void {
  if (installed) return;
  installed = true;
  window.addEventListener("error", (event: Event) => {
    if (event instanceof ErrorEvent) reportError(event.error ?? new Error(event.message), { stage: "global" });
    else if (event.target instanceof HTMLScriptElement || event.target instanceof HTMLLinkElement) reportError(new Error("Application resource failed to load"), { stage: "resource" });
  }, true);
  window.addEventListener("unhandledrejection", (event) => reportError(event.reason, { stage: "unhandled_rejection" }));
  void initialize();
}

async function initialize(): Promise<void> {
  try {
    const token = accessToken();
    if (!token) return;
    const response = await fetch("/api/telemetry/config", { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1000) });
    if (!response.ok) return;
    const config: TelemetryConfig = await response.json();
    if (!config.enabled || !config.dsn) return;
    const { createBrowserReporter } = await import("./telemetry-client.ts");
    // Identify the actual loaded browser bundle, even if a retained bridge differs.
    reporter = createBrowserReporter({ ...config, buildId, release });
    const browser = navigator.userAgent.match(/(?:Firefox|Edg|Chrome|Version)\/[\d.]+/)?.[0] ?? "unknown";
    reporter.setState({ ...state, browser, platform: navigator.platform });
    state = { ...state, browser, platform: navigator.platform };
    for (const item of early) reporter.capture(item.error, item.context);
  } catch { /* Missing config, old bridges and unreachable telemetry do not block startup. */ }
  finally { early = []; pending = false; }
}
