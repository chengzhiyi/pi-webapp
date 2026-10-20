import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep, win32 } from "node:path";

export class WorkspaceGitError extends Error {
  readonly status: number;
  readonly reason: string;
  constructor(message: string, status = 400, reason = "git_failed") { super(message); this.name = "WorkspaceGitError"; this.status = status; this.reason = reason; }
}

/** No shell, inherited Git redirections, optional index writes, prompts or filesystem monitor hooks. */
export function git(cwd: string, args: string[], limit = 2 * 1024 * 1024, options: { write?: boolean; input?: string } = {}): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  return new Promise((resolveResult, reject) => {
    const child = execFile("git", ["--no-pager", "--literal-pathspecs", "-c", "core.fsmonitor=false", ...args], {
      cwd, env: { ...env, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1" },
      encoding: "utf8", timeout: options.write ? 30000 : 10000, maxBuffer: limit, windowsHide: true,
    }, (error, stdout, stderr) => {
      if (!error) { resolveResult(stdout); return; }
      if (options.write) {
        const reason = error.killed || (error as NodeJS.ErrnoException).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "outcome_unknown"
          : /index\.lock|cannot lock ref|could not lock/i.test(stderr) ? "index_locked"
          : /already exists/i.test(stderr) ? "branch_exists" : /already checked out|used by worktree/i.test(stderr) ? "branch_in_use"
          : /would be overwritten|local changes/i.test(stderr) ? "dirty_worktree" : /identity unknown|unable to auto-detect email|empty ident/i.test(stderr) ? "identity_missing" : "git_failed";
        reject(new WorkspaceGitError("Git 操作失败，请刷新检查仓库状态、身份或 hooks 配置", reason === "outcome_unknown" ? 503 : 409, reason)); return;
      }
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") reject(new WorkspaceGitError("Git 未安装或工作区不可用", 503));
      else if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") reject(new WorkspaceGitError("Git 输出过大，请缩小读取范围", 413));
      else if (/not a git repository/.test(stderr)) reject(new WorkspaceGitError("当前目录不是 Git 仓库", 404));
      else reject(new WorkspaceGitError(error.killed ? "Git 读取超时，请重试" : "Git 读取失败，请检查仓库状态和目录权限", 503));
    });
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

export interface GitRepository { kind: "repository"; cwd: string; root: string; scope: string }
export async function gitRepository(cwd: string): Promise<GitRepository | { kind: "not-repository" | "unavailable" }> {
  const canonical = await realpath(cwd);
  let root: string;
  try { root = (await git(canonical, ["rev-parse", "--show-toplevel"])).replace(/\n$/, ""); }
  catch (error) {
    if (error instanceof WorkspaceGitError && error.status === 404) return { kind: "not-repository" };
    if (error instanceof WorkspaceGitError && error.message === "Git 未安装或工作区不可用") return { kind: "unavailable" };
    throw error;
  }
  const prefix = relative(root, canonical).split(sep).join("/");
  if (prefix === ".." || prefix.startsWith("../") || isAbsolute(prefix)) throw new WorkspaceGitError("仓库位于工作区之外", 403);
  return { kind: "repository", cwd: canonical, root, scope: prefix ? `${prefix}/` : "" };
}

export function validateGitPath(path: string): void {
  if (typeof path !== "string" || !path || path.length > 4096 || path.includes("\0") || path.includes("\\") || isAbsolute(path) || win32.isAbsolute(path) || path.split("/").some(part => !part || part === "." || part === "..")) {
    throw new WorkspaceGitError("工作区文件路径无效", 403);
  }
}
