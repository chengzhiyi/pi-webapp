import { HostedPluginError, failure } from "./errors.ts";
import type { HostedActionInput, HostedManageInput } from "../../../../contracts/hosted-plugins.ts";

export interface HostedBridgeHandlers {
  inventory(): Promise<unknown>;
  manage(input: HostedManageInput): Promise<unknown>;
  /** checkpointOnly is set by the host's restart fence, never parsed from JSON. */
  action(input: HostedActionInput, options?: { checkpointOnly: boolean }): Promise<unknown>;
  views(input: Record<string, unknown>): Promise<unknown>;
  asset(path: string): Promise<{bytes: Buffer; mime: string} | null>;
}
export const HOSTED_API_PATHS = ["/api/hosted-plugins/manage", "/api/hosted-plugins/action", "/api/hosted-plugins/views"];
/** Parse only authenticated wire DTOs. cwd/workspace from an iframe are never propagated. */
export async function hostedApi(host: HostedBridgeHandlers | undefined, path: string, input: unknown, options?: { draining: boolean }): Promise<unknown> {
  if (!host) throw new HostedPluginError("hosted_unavailable", "Hosted plugin integration is not available in this runtime", {status: 503});
  if (path === "/api/hosted-plugins") return host.inventory();
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new HostedPluginError("invalid_input", "Expected plugin request object", {status: 400});
  const body = input as Record<string, unknown>;
  if (path === "/api/hosted-plugins/views") {
    if (options?.draining && !["poll", "pollMany", "change", "ack", "close", "reconcile", "cancel-initialization"].includes(String(body.operation))) throw new HostedPluginError("host_restarting", "Only existing view status/flush acknowledgements are admitted during restart", { status: 409 });
    if (body.operation !== "pollMany") return host.views(body);
    // Bounded read-only aggregation. Every member still traverses the authenticated
    // session resolver and exact generation/mount/token checks in host.views.
    if (!Array.isArray(body.views) || !body.views.length || body.views.length > 64 || body.views.some(view => !view || typeof view !== "object" || Array.isArray(view) || view.operation !== "poll")) throw new HostedPluginError("invalid_input", "Expected 1–64 view polls", { status: 400 });
    return { replies: await Promise.all(body.views.map(async view => {
      try { return { reply: await host.views({ ...view, operation: "poll", immediate: true }) }; }
      catch (error) { return { failure: hostedHttpFailure(error) }; }
    })) };
  }
  if (typeof body.pluginId !== "string" || body.pluginId.length > 214) throw new HostedPluginError("invalid_input", "Invalid plugin identity", {status: 400});
  if (path === "/api/hosted-plugins/manage") {
    if (options?.draining) throw new HostedPluginError("host_restarting", "Host is updating; plugin management is fenced", { status: 409 });
    if (typeof body.operation !== "string" || !["install", "enable", "disable", "update", "uninstall", "check", "retry", "policy", "cancel-download"].includes(body.operation) || body.version !== undefined && (typeof body.version !== "string" || !/^\d+\.\d+\.\d+$/.test(body.version))) throw new HostedPluginError("invalid_input", "Invalid plugin management request", {status: 400});
    if (body.downloadId !== undefined && (typeof body.downloadId !== "string" || !/^[a-f0-9-]{36}$/.test(body.downloadId)) || body.operation === "cancel-download" && !body.downloadId) throw new HostedPluginError("invalid_input", "Exact download identity required", {status:400});
    if (body.reopenEditors !== undefined && typeof body.reopenEditors !== "boolean") throw new HostedPluginError("invalid_input", "Invalid editor reopen consent", {status:400});
    if (body.updatePolicy !== undefined && !["notify", "automatic", "pinned"].includes(body.updatePolicy as string) || body.operation === "policy" && (typeof body.updatePolicy !== "string" || body.updatePolicy === "pinned" && !body.version)) throw new HostedPluginError("invalid_input", "Invalid update policy or missing exact pin", {status:400});
    return host.manage({pluginId: body.pluginId,operation:body.operation as Parameters<HostedBridgeHandlers["manage"]>[0]["operation"],...(typeof body.downloadId === "string" ? {downloadId:body.downloadId} : {}),...(typeof body.updatePolicy === "string" ? {updatePolicy:body.updatePolicy as HostedManageInput["updatePolicy"]} : {}),...(typeof body.version === "string" ? {version:body.version} : {}),...(typeof body.reopenEditors === "boolean" ? {reopenEditors:body.reopenEditors} : {})});
  }
  if (path === "/api/hosted-plugins/action") {
    if (typeof body.sessionId !== "string" || !body.sessionId || body.sessionId.length > 200 || !Number.isSafeInteger(body.generation) || Number(body.generation) < 1 || typeof body.action !== "string" || !/^[\w.-]{1,80}$/.test(body.action)) throw new HostedPluginError("invalid_input", "Invalid plugin action request", {status: 400});
    if (body.viewToken !== undefined && (typeof body.viewToken !== "string" || body.viewToken.length > 200) || body.mountId !== undefined && (typeof body.mountId !== "string" || body.mountId.length > 200)) throw new HostedPluginError("invalid_input", "Invalid view flush capability", {status:400});
    return host.action({sessionId:body.sessionId,pluginId:body.pluginId,generation:Number(body.generation),action:body.action,input:body.input ?? {},...(typeof body.viewToken === "string" ? {viewToken:body.viewToken} : {}),...(typeof body.mountId === "string" ? {mountId:body.mountId} : {})}, options?.draining ? { checkpointOnly: true } : undefined);
  }
  throw new HostedPluginError("invalid_route", "Unknown hosted plugin route", {status:404});
}
export function hostedHttpFailure(error: unknown): { status: number; body: unknown } {
  const detail = failure(error);
  const status = detail.status ?? (["invalid_input", "unknown_plugin", "invalid_operation", "invalid_version"].includes(detail.code) ? 400 : ["not_installed"].includes(detail.code) ? 404 : ["stale_generation", "plugin_unavailable", "drain_pending", "editor_busy", "version_pinned", "runtime_owned", "storage_busy", "revision_conflict", "file_conflict", "legacy_busy"].includes(detail.code) ? 409 : 500);
  return {status,body:{error:detail.message,errorCode:detail.code,...(detail.reason ? {reason:detail.reason} : {})}};
}
