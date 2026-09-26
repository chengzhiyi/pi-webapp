import { realpath } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";

/** Pi's encoded session directory can be shared by different cwd paths. */
export async function sessionsForWorkspace(path: string) {
  const canonical = await realpath(path);
  const saved = await SessionManager.list(canonical);
  const belongs = await Promise.all(saved.map(async (session) =>
    session.cwd !== "" && await realpath(session.cwd).catch(() => null) === canonical));
  return saved.filter((_, index) => belongs[index]);
}
