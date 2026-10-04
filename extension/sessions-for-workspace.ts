import { realpath } from "node:fs/promises";
import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { requireWorkspaceDirectory } from "./workspaces.ts";

/** Pi's encoded session directory can be shared by different cwd paths. */
export async function sessionsForWorkspace(path: string, allSessions?: SessionInfo[]) {
  const canonical = await requireWorkspaceDirectory(path);
  const saved = allSessions ?? await SessionManager.listAll();
  const belongs = await Promise.all(saved.map(async (session) =>
    session.cwd !== "" && await realpath(session.cwd).catch(() => null) === canonical));
  return saved.filter((_, index) => belongs[index]);
}
