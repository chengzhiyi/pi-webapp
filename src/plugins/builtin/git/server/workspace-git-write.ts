import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { GitControlState, GitWriteAction, GitWriteReason, GitWriteResult } from "../contract/workspace-git.ts";
import { git, gitRepository, validateGitPath, WorkspaceGitError, type GitRepository } from "./git-command.ts";
import { workspaceGitStatus } from "./workspace-git.ts";

const leases = new Set<string>();
const fail = (reason: GitWriteReason, status = 409): never => { throw new WorkspaceGitError("Git 状态不允许此操作，请刷新后检查", status, reason); };

async function commonDirectory(cwd: string) {
  return realpath(resolve(cwd, (await git(cwd, ["rev-parse", "--git-common-dir"])).replace(/\n$/, "")));
}

/** Shared refs and worktrees use one short lease; callers reject rather than queue stale operations. */
export async function withGitWorktreeLease<T>(cwd: string, operation: () => Promise<T>, optional = false): Promise<T> {
  let key: string | null = null;
  try {
    const repository = await gitRepository(cwd);
    if (repository.kind === "repository") key = await commonDirectory(repository.cwd);
  } catch (error) {
    // Agent starts must still work in non-Git, missing or Git-unavailable workspaces.
    // Writes use the strict default and cannot run if repository discovery fails.
    if (!optional) throw error;
  }
  if (!key) return operation();
  if (leases.has(key)) return fail("busy");
  leases.add(key);
  try { return await operation(); } finally { leases.delete(key); }
}

export async function workspaceGitControl(cwd: string): Promise<GitControlState> {
  const repository = await gitRepository(cwd);
  const empty: GitControlState = { kind: repository.kind, root: null, scope: "", head: null, branch: null, version: "", staged: 0, dirty: false, blocked: null, branches: [] };
  if (repository.kind !== "repository") return empty;
  const status = await workspaceGitStatus(repository.root);
  if (status.kind !== "repository") return empty;
  const [index, refs, gitDir] = await Promise.all([
    git(repository.cwd, ["ls-files", "--stage", "-z"]),
    git(repository.cwd, ["for-each-ref", "--format=%(refname:short)%00%(objectname)%00%(worktreepath)", "refs/heads"]),
    git(repository.cwd, ["rev-parse", "--absolute-git-dir"]),
  ]);
  const markers = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer", "BISECT_LOG", "index.lock"];
  const present = (await Promise.all(markers.map(async marker => {
    try { await lstat(resolve(gitDir.replace(/\n$/, ""), marker)); return marker; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }))).filter(Boolean);
  const files = await Promise.all(status.entries.map(async entry => {
    try { const file = await lstat(resolve(repository.root, entry.path)); return [entry.path, file.size, file.mtimeMs, file.ctimeMs, file.ino, file.mode]; }
    catch (error) { if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return [entry.path, "missing"]; throw error; }
  }));
  const branches = refs.split("\n").filter(Boolean).map(line => {
    const [name, , worktree] = line.split("\0"); return { name: name!, current: name === status.branch, occupied: !!worktree && name !== status.branch };
  });
  const blocked: GitWriteReason | null = status.truncated || branches.length > 512 ? "too_many_changes" : present.includes("index.lock") ? "index_locked" : present.length || status.entries.some(entry => entry.conflict) ? "operation_in_progress" : null;
  const version = createHash("sha256").update(JSON.stringify({ head: status.head, branch: status.branch, index, refs, entries: status.entries, files, present })).digest("hex");
  return { kind: "repository", root: repository.root, scope: repository.scope, head: status.head, branch: status.branch, version, staged: status.entries.filter(entry => !entry.untracked && entry.index !== ".").length,
    dirty: status.entries.length > 0, blocked, branches: branches.slice(0, 512) };
}

async function scopedFile(repository: GitRepository, path: string) {
  validateGitPath(path);
  // Git must never traverse an escaping parent link. Missing parents are valid for deletions.
  let parent = dirname(resolve(repository.cwd, path));
  while (true) {
    try {
      const canonical = await realpath(parent); const inside = relative(repository.cwd, canonical);
      if (inside === ".." || inside.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(inside)) return fail("invalid_path", 403);
      break;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; parent = dirname(parent); }
  }
  const status = await workspaceGitStatus(repository.cwd);
  const entry = status.kind === "repository" ? status.entries.find(entry => entry.path === path) : undefined;
  if (!entry || entry.submodule || entry.conflict) return fail("invalid_path", 400);
  try { const info = await lstat(resolve(repository.cwd, path)); if (!info.isFile() && !info.isSymbolicLink()) return fail("invalid_path", 400); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return entry;
}

export async function workspaceGitWrite(cwd: string, input: Record<string, unknown>, guard: (root: string) => void): Promise<GitWriteResult> {
  const action = input.action as GitWriteAction;
  if (!["stage", "unstage", "commit", "create-branch", "switch-branch"].includes(action) || typeof input.expected !== "string" || !/^[a-f0-9]{64}$/.test(input.expected)) throw new WorkspaceGitError("Git 操作参数无效");
  return withGitWorktreeLease(cwd, async () => {
    const repository = await gitRepository(cwd); if (repository.kind !== "repository") return fail("invalid_path", 404);
    guard(repository.root);
    const control = await workspaceGitControl(repository.cwd);
    if (control.version !== input.expected) return fail("state_changed");
    if (control.blocked) return fail(control.blocked);
    let args: string[];
    let message: string | undefined;
    if (action === "stage" || action === "unstage") {
      if (typeof input.path !== "string") return fail("invalid_path", 400);
      const entry = await scopedFile(repository, input.path);
      if (action === "stage" && !entry.untracked && entry.worktree === ".") return fail("state_changed");
      if (action === "unstage" && (entry.untracked || entry.index === ".")) return fail("state_changed");
      const paths = [input.path];
      if (action === "unstage" && entry.originalPath) { validateGitPath(entry.originalPath); paths.push(entry.originalPath); }
      args = action === "stage" ? ["add", "--", ...paths] : control.head ? ["restore", "--staged", "--", ...paths] : ["rm", "--cached", "-f", "--ignore-unmatch", "--", ...paths];
    } else if (action === "commit") {
      if (repository.scope) return fail("root_required", 400);
      if (typeof input.message !== "string" || !input.message.trim() || input.message.includes("\0") || Buffer.byteLength(input.message) > 8192) return fail("invalid_message", 400);
      if (!control.staged) return fail("nothing_staged", 400);
      message = input.message; args = ["commit", "--file=-", "--cleanup=verbatim"];
    } else {
      if (!control.head) return fail("no_commits", 400);
      if (typeof input.branch !== "string" || !input.branch || input.branch.length > 256 || input.branch.startsWith("-") || input.branch.startsWith("refs/") || ["HEAD", "@"].includes(input.branch) || /[\0\r\n]|@\{/.test(input.branch)) return fail("invalid_branch", 400);
      try { await git(repository.cwd, ["check-ref-format", "--branch", input.branch]); } catch { return fail("invalid_branch", 400); }
      if (input.checkout !== undefined && typeof input.checkout !== "boolean") return fail("invalid_branch", 400);
      const branch = control.branches.find(branch => branch.name === input.branch);
      const checkout = action === "switch-branch" || input.checkout === true;
      if (action === "create-branch" && branch) return fail("branch_exists");
      if (action === "switch-branch" && (!branch || branch.current)) return fail("invalid_branch", 400);
      if (checkout && repository.scope) return fail("root_required", 400);
      if (checkout && control.dirty) return fail("dirty_worktree");
      if (branch?.occupied) return fail("branch_in_use");
      args = action === "switch-branch" ? ["switch", "--no-guess", "--no-overwrite-ignore", "--", input.branch]
        : checkout ? ["switch", "--no-guess", "--no-overwrite-ignore", "-c", input.branch, "--", "HEAD"] : ["branch", "--", input.branch, "HEAD"];
    }
    // The final check is after all asynchronous preparation, immediately before the subprocess starts.
    const latest = await workspaceGitControl(repository.cwd);
    if (latest.version !== input.expected || latest.blocked) return fail(latest.blocked ?? "state_changed");
    guard(repository.root);
    await git(repository.cwd, args, 2 * 1024 * 1024, { write: true, input: message });
    const head = (await git(repository.cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]).catch(() => "")).trim() || null;
    return { action, head };
  });
}
