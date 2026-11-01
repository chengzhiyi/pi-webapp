import type { HostedInvocation } from "@chengzhiyi/pi-web-protocol";
import { HostedPluginError } from "../errors.ts";
import { parseDeclarations } from "./declarations.ts";
import { pluginFetch, type NetworkDeps } from "./network.ts";
import { pluginSessions, type SessionsHost } from "./sessions.ts";

export interface CapabilityBrokerOptions extends NetworkDeps {
  sessions?: SessionsHost;
  maxActiveSessions?: number;
}
const METHODS = new Set(["network.fetch", "sessions.create", "sessions.send", "sessions.abort", "sessions.release", "sessions.events"]);
/** Extension point for the state broker: declared-capability methods only. Secrets have no read method by design. */
export class CapabilityBroker {
  private readonly options: CapabilityBrokerOptions;
  constructor(options: CapabilityBrokerOptions) { this.options = options; }
  handles(method: string): boolean { return METHODS.has(method); }
  async call(pluginId: string, manifest: unknown, invocation: HostedInvocation, method: string, input: unknown): Promise<unknown> {
    const declared = parseDeclarations(manifest);
    if (method === "network.fetch") {
      if (!declared.networkHosts.length) throw new HostedPluginError("capability_denied", "Plugin did not declare network access", { status: 403 });
      return pluginFetch(pluginId, declared.networkHosts, declared.secrets, input, this.options);
    }
    if (!declared.sessions || !this.options.sessions) throw new HostedPluginError("capability_denied", "Sessions capability is unavailable", { status: 403 });
    return pluginSessions(this.options.sessions, pluginId, invocation.scope.cwd, method, input, this.options.maxActiveSessions ?? 3);
  }
}
