import type { DetachedEvent, WorkspaceSessions } from "../../../sessions/workspace-sessions.ts";
import type { PluginSessionEvent, SessionsHost } from "./sessions.ts";

type Detached = Pick<WorkspaceSessions, "createDetached" | "detachedOwner" | "detachedCount" | "sendDetached" | "abortDetached" | "releaseDetached" | "detachedEvents">;
/** `authorizeExecute` is mandatory: lifting the read-only restriction is a human decision the host must bind to its own UI or policy. It resolves true to allow and throws a coded error otherwise. */
export function workspaceSessionsHost(sessions: Detached, authorizeExecute: (pluginId: string, sessionId: string) => Promise<boolean>): SessionsHost {
  const event = (e: DetachedEvent): PluginSessionEvent => ({ seq: e.seq, type: e.type, ...(e.text === undefined ? {} : { text: e.text }) });
  return {
    async create({ pluginId, cwd, title, prompt }) {
      const sessionId = await sessions.createDetached(cwd, pluginId, title);
      // A session whose first prompt is rejected must not keep consuming the plugin's quota.
      try { await sessions.sendDetached(sessionId, prompt, false); } catch (error) { await sessions.releaseDetached(sessionId); throw error; }
      return { sessionId };
    },
    ownerOf: id => sessions.detachedOwner(id),
    activeCount: pluginId => sessions.detachedCount(pluginId),
    async send(sessionId, message, mode) {
      const owner = sessions.detachedOwner(sessionId);
      if (mode === "execute" && (!owner || !await authorizeExecute(owner, sessionId))) throw Object.assign(new Error("Execution was not authorized by the host"), { code: "execute_denied", status: 403 });
      await sessions.sendDetached(sessionId, message, mode === "execute");
    },
    abort: id => sessions.abortDetached(id),
    release: id => sessions.releaseDetached(id),
    async events(id, after) { const r = sessions.detachedEvents(id, after); return { events: r.events.map(event), next: r.next }; },
  };
}
