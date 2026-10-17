import { workspaceGitDiff, workspaceGitStatus } from "./workspace-git.ts";
import { workspaceGitHistory, workspaceGitCommit, workspaceGitCommitDiff } from "./workspace-git-history.ts";
import { workspaceGitControl } from "./workspace-git-write.ts";
import { WorkspaceGitError } from "./git-command.ts";
import type { GitDiffArea } from "../shared/workspace-git.ts";

export const workspaceGitRoutes = ["/api/workspace/git/control", "/api/workspace/git/write", "/api/workspace/git/status", "/api/workspace/git/diff", "/api/workspace/git/history", "/api/workspace/git/commit-detail", "/api/workspace/git/commit-diff"];

/** Called after bridge authentication and session selection checks. */
export function workspaceGitRequest(route: string, cwd: string, input: Record<string, unknown>): Promise<unknown> {
  if (route.endsWith("/control")) return workspaceGitControl(cwd);
  if (route.endsWith("/status")) return workspaceGitStatus(cwd);
  if (route.endsWith("/history")) {
    if ((input.limit !== undefined && typeof input.limit !== "number") || (input.cursor !== undefined && typeof input.cursor !== "string")) throw new WorkspaceGitError("历史分页参数无效");
    return workspaceGitHistory(cwd, { limit: input.limit as number | undefined, cursor: input.cursor as string | undefined });
  }
  if (route.endsWith("/diff")) {
    if (typeof input.path !== "string" || !["staged", "unstaged", "untracked"].includes(input.area as string)) throw new WorkspaceGitError("Git 差异参数无效");
    return workspaceGitDiff(cwd, input.path, input.area as GitDiffArea);
  }
  if (typeof input.hash !== "string" || (input.parentIndex !== undefined && (!Number.isInteger(input.parentIndex) || (input.parentIndex as number) < 0))) throw new WorkspaceGitError("提交参数无效");
  const parent = input.parentIndex as number | undefined;
  if (route.endsWith("/commit-detail")) return workspaceGitCommit(cwd, input.hash, parent);
  if (route.endsWith("/commit-diff") && typeof input.path === "string") return workspaceGitCommitDiff(cwd, input.hash, input.path, parent);
  throw new WorkspaceGitError("Git 差异参数无效");
}
