import { join } from "node:path";
import type { HostedScope } from "@chengzhiyi/pi-web-protocol";
import type { CapabilityBrokerOptions } from "./broker.ts";
import { ExecuteApprovals } from "./execute-approvals.ts";
import { FileSecretStore } from "./secrets.ts";
import { workspaceSessionsHost } from "./workspace-sessions-host.ts";
import type { WorkspaceSessions } from "../../../sessions/workspace-sessions.ts";

type Detached = Parameters<typeof workspaceSessionsHost>[0];
export interface HostedCapabilityWiring {
  /** Hosted storage root; secrets live beside, not inside, plugin state. */
  root: string;
  /** WorkspaceSessions is created after the hosted integration, so it is resolved lazily. */
  sessions(): WorkspaceSessions | null;
  /** Display name for approval prompts. */
  sessionTitle?(sessionId: string): string | undefined;
  /** Notifies the browser that pending approvals changed. */
  changed?(): void;
  /** Active workspace directory, or null when none is selected. */
  activeWorkspace(): string | null;
  trustedScope(cwd: string, sessionId: string): HostedScope;
}
/** Synthetic session id for scheduled ticks: plugin state for ticks is workspace-level, not tied to a chat. */
export const SCHEDULER_SESSION_ID = "scheduler";

export function hostedCapabilities(wiring: HostedCapabilityWiring): { capabilities: CapabilityBrokerOptions; scheduledScope(pluginId: string): HostedScope | null; approvals: ExecuteApprovals } {
  const approvals = new ExecuteApprovals({ describe: wiring.sessionTitle, changed: wiring.changed });
  const need = () => { const s = wiring.sessions(); if (!s) throw Object.assign(new Error("Workspace sessions are not available yet"), { code: "sessions_unavailable", status: 503 }); return s; };
  const lazy: Detached = {
    createDetached: (...a) => need().createDetached(...a),
    detachedOwner: id => wiring.sessions()?.detachedOwner(id) ?? null,
    detachedCount: owner => wiring.sessions()?.detachedCount(owner) ?? 0,
    sendDetached: (...a) => need().sendDetached(...a),
    abortDetached: id => need().abortDetached(id),
    releaseDetached: async id => { approvals.forget(id); await need().releaseDetached(id); },
    detachedEvents: (...a) => need().detachedEvents(...a),
  };
  return {
    approvals,
    capabilities: { secrets: new FileSecretStore(join(wiring.root, "capability-secrets")), sessions: workspaceSessionsHost(lazy, (pluginId, sessionId) => approvals.authorize(pluginId, sessionId)) },
    scheduledScope: () => {
      const cwd = wiring.activeWorkspace();
      if (!cwd) return null;
      try { return wiring.trustedScope(cwd, SCHEDULER_SESSION_ID); } catch { return null; }
    },
  };
}
