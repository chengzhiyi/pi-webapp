import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import type { GitDiffArea, GitFileChange, WorkspaceGitDiff, WorkspaceGitStatus } from "../shared/workspace-git.ts";
import { previewWorkspaceFile } from "./workspace-files.ts";
import { git, gitRepository, validateGitPath, WorkspaceGitError } from "./git-command.ts";
export { WorkspaceGitError } from "./git-command.ts";

const MAX_FILES = 1000;
const MAX_PATCH_BYTES = 512 * 1024;
const MAX_PATCH_LINES = 10000;

function workspaceRelative(scope: string, path: string): string | undefined {
  return path.startsWith(scope) ? path.slice(scope.length) || undefined : undefined;
}

export async function workspaceGitStatus(cwd: string): Promise<WorkspaceGitStatus> {
  const repository = await gitRepository(cwd);
  if (repository.kind !== "repository") return repository;
  const { root, scope } = repository;
  const output = await git(repository.cwd, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all", "--", "."]);
  const status: Extract<WorkspaceGitStatus, { kind: "repository" }> = {
    kind: "repository", root, scope, branch: null, head: null, upstream: null, ahead: null, behind: null, entries: [], truncated: false,
  };
  const records = output.split("\0");
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;
    if (record.startsWith("# branch.oid ")) { const value = record.slice(13); status.head = value === "(initial)" ? null : value; continue; }
    if (record.startsWith("# branch.head ")) { const value = record.slice(14); status.branch = value === "(detached)" ? null : value; continue; }
    if (record.startsWith("# branch.upstream ")) { status.upstream = record.slice(18); continue; }
    if (record.startsWith("# branch.ab ")) { const match = record.match(/\+(\d+) -(\d+)/); if (match) { status.ahead = Number(match[1]); status.behind = Number(match[2]); } continue; }
    const type = record[0];
    if (!["1", "2", "u", "?"].includes(type ?? "")) continue;
    // Split only the fixed metadata fields: spaces and newlines in filenames are literal with -z.
    const fields = type === "?" ? 1 : type === "1" ? 8 : type === "2" ? 9 : 10;
    let start = 0;
    for (let part = 0; part < fields; part++) start = record.indexOf(" ", start) + 1;
    const path = workspaceRelative(scope, record.slice(start));
    const original = type === "2" ? records[++index] : undefined;
    if (!path) continue;
    if (status.entries.length === MAX_FILES) { status.truncated = true; continue; }
    const metadata = record.slice(0, start).split(" ");
    const change: GitFileChange = {
      path, index: type === "?" ? "?" : metadata[1]![0]!, worktree: type === "?" ? "?" : metadata[1]![1]!,
      conflict: type === "u", untracked: type === "?", submodule: type !== "?" && metadata[2] !== "N...",
    };
    const originalPath = original === undefined ? undefined : workspaceRelative(scope, original);
    if (originalPath) change.originalPath = originalPath;
    status.entries.push(change);
  }
  return status;
}

export async function workspaceGitDiff(cwd: string, path: string, area: GitDiffArea): Promise<WorkspaceGitDiff> {
  validateGitPath(path);
  if (!["staged", "unstaged", "untracked"].includes(area)) throw new WorkspaceGitError("Git 差异范围无效");
  const status = await workspaceGitStatus(cwd);
  if (status.kind !== "repository") throw new WorkspaceGitError("当前工作区没有可读取的 Git 仓库", 404);
  const meta = { path, area };
  const change = status.entries.find(entry => entry.path === path);
  if (!change) return { ...meta, kind: "empty" };
  if (change.conflict) return { ...meta, kind: "conflict" };
  if (change.submodule) return { ...meta, kind: "submodule" };
  if (area === "untracked") {
    if (!change.untracked) return { ...meta, kind: "empty" };
    if (!(await lstat(resolve(cwd, path))).isFile()) return { ...meta, kind: "unsupported" };
    const preview = await previewWorkspaceFile(cwd, path);
    if (preview.kind === "too-large") return { ...meta, kind: "too-large" };
    if (preview.kind !== "text") return { ...meta, kind: "binary" };
    if (!preview.text) return { ...meta, kind: "empty" };
    const lines = preview.text.split("\n");
    const newline = lines.at(-1) === "";
    if (newline) lines.pop();
    const patch = `--- /dev/null\n+++ b/${path.replace(/[\r\n]/g, " ")}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(line => `+${line}`).join("\n")}\n${newline ? "" : "\\ No newline at end of file\n"}`;
    return Buffer.byteLength(patch) > MAX_PATCH_BYTES || lines.length > MAX_PATCH_LINES ? { ...meta, kind: "too-large" } : { ...meta, kind: "text", patch };
  }
  if (change.untracked || (area === "staged" ? change.index : change.worktree) === ".") return { ...meta, kind: "empty" };
  const paths = area === "staged" && change.originalPath ? [path, change.originalPath] : [path];
  try {
    // Disable rename detection so out-of-scope source files cannot enter a scoped diff.
    const patch = await git(cwd, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--relative", "--src-prefix=a/", "--dst-prefix=b/", ...(area === "staged" ? ["--cached"] : []), "--", ...paths], MAX_PATCH_BYTES);
    if (!patch) return { ...meta, kind: "empty" };
    if (patch.split("\n").length > MAX_PATCH_LINES) return { ...meta, kind: "too-large" };
    if (/^Binary files /m.test(patch)) return { ...meta, kind: "binary" };
    return { ...meta, kind: "text", patch };
  } catch (error) {
    if (error instanceof WorkspaceGitError && error.status === 413) return { ...meta, kind: "too-large" };
    throw error;
  }
}
