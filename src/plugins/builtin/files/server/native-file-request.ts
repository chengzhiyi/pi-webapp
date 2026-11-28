import { createNativeFileActions } from "../../../../../desktop/native-file-actions.mjs";
import type { PluginRequestContext } from "../../../../host/server/plugins/server-plugin.ts";

const run = createNativeFileActions();

export async function handleNativeFileRequest({ body, localFileRequest, snapshot, json }: PluginRequestContext) {
  if (!localFileRequest || !run) {
    json(403, { ok: false, reason: "failed" });
    return;
  }
  const { operation, target, appId } = body;
  if (operation !== "show" && operation !== "list" && operation !== "open") {
    json(400, { ok: false, reason: "failed" });
    return;
  }
  const session = snapshot();
  const workspaceTarget = typeof target === "object" && target !== null && Object.hasOwn(target, "workspaceId");
  if (!workspaceTarget && body.sessionId !== session.sessionId) {
    json(409, { ok: false, reason: "not-found" });
    return;
  }
  const trusted = () => {
    if (!localFileRequest.trusted()) return false;
    if (workspaceTarget) return true;
    const current = snapshot();
    return current.sessionId === session.sessionId && current.cwd === session.cwd;
  };
  const result = await run(operation, target, appId, {
    trusted,
    async lookupRoot(parsed) {
      if (parsed.sessionId !== undefined) return parsed.sessionId === session.sessionId && trusted() ? session.cwd : undefined;
      const item = (await localFileRequest.workspaces()).items.find(item => item.id === parsed.workspaceId);
      return item?.available === false ? undefined : item?.path;
    },
  });
  json(200, result);
}
