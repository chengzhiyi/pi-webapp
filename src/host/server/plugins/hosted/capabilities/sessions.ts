import { HostedPluginError } from "../errors.ts";

export interface PluginSessionEvent { seq: number; type: "turn_end" | "plan_ready" | "question" | "error"; text?: string }
/** Implemented by the host's session layer. Sessions are tagged with the creating plugin. */
export interface SessionsHost {
  create(options: { pluginId: string; cwd: string; title: string; prompt: string; mode: "plan" }): Promise<{ sessionId: string }>;
  ownerOf(sessionId: string): string | null;
  activeCount(pluginId: string): number;
  send(sessionId: string, message: string, mode?: "execute"): Promise<void>;
  abort(sessionId: string): Promise<void>;
  /** Close the session and free the plugin's quota. */
  release(sessionId: string): Promise<void>;
  events(sessionId: string, after: number): Promise<{ events: PluginSessionEvent[]; next: number }>;
}
const str = (v: unknown, max: number, what: string): string => {
  if (typeof v !== "string" || !v || v.length > max) throw new HostedPluginError("invalid_input", `Invalid ${what}`);
  return v;
};
/** Ownership and quota are enforced here, not trusted to the plugin. cwd always comes from the authenticated invocation. */
export async function pluginSessions(host: SessionsHost, pluginId: string, cwd: string, method: string, raw: unknown, maxActive: number): Promise<unknown> {
  const input = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  if (method === "sessions.create") {
    if (input.mode !== "plan") throw new HostedPluginError("invalid_input", "Plugin sessions must start in plan mode");
    if (host.activeCount(pluginId) >= maxActive) throw new HostedPluginError("quota_exceeded", "Too many active plugin sessions", { status: 429 });
    return host.create({ pluginId, cwd, title: str(input.title, 200, "title"), prompt: str(input.prompt, 64 * 1024, "prompt"), mode: "plan" });
  }
  const id = str(input.sessionId, 200, "sessionId");
  if (host.ownerOf(id) !== pluginId) throw new HostedPluginError("session_denied", "Session was not created by this plugin", { status: 403 });
  switch (method) {
    case "sessions.send":
      if (input.mode !== undefined && input.mode !== "execute") throw new HostedPluginError("invalid_input", "Invalid mode");
      await host.send(id, str(input.message, 64 * 1024, "message"), input.mode as "execute" | undefined);
      return { ok: true };
    case "sessions.release": await host.release(id); return { ok: true };
    case "sessions.abort": await host.abort(id); return { ok: true };
    case "sessions.events": return host.events(id, Number.isSafeInteger(input.after) && (input.after as number) >= 0 ? input.after as number : 0);
    default: throw new HostedPluginError("method_denied", "Unknown sessions method");
  }
}
