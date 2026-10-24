import type { ServerPlugin } from "../../../../host/server/plugins/server-plugin.ts";
import { metadata } from "../contract/manifest.ts";
import { DiagramError } from "../contract/diagrams.ts";
import { DiagramStore } from "./store.ts";
const actions = ["list", "new", "get", "open", "import", "sync", "accept", "reject", "save"];
export function createDiagramsPlugin(): ServerPlugin {
  const store = new DiagramStore();
  return {
    metadata, routes: actions.map(action => `/api/diagrams/${action}`),
    agentAction: (cwd, sessionId, action, input) => store.tool(cwd, sessionId, action, input),
    async handle({ path, body, snapshot, json }) {
      const session = snapshot();
      const guard = () => { const now = snapshot(); if (body.sessionId !== session.sessionId || now.sessionId !== session.sessionId || now.cwd !== session.cwd) throw new DiagramError("会话已切换", 409); };
      try { const value = await store.action(session.cwd, session.sessionId, path.split("/").at(-1)!, body, guard); json(200, value); }
      catch (error) { if (error instanceof DiagramError) json(error.status, { error: error.message, errorCode: "validation_error" }); else throw error; }
    },
  };
}
