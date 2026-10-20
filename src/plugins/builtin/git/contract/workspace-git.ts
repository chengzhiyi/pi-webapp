export type GitDiffArea = "staged" | "unstaged" | "untracked";

/** Paths are relative to the session workspace, never arbitrary repository paths. */
export interface GitFileChange {
  path: string;
  originalPath?: string;
  index: string;
  worktree: string;
  conflict: boolean;
  untracked: boolean;
  submodule: boolean;
}

export type WorkspaceGitStatus = { kind: "not-repository" | "unavailable" } | {
  kind: "repository";
  root: string;
  scope: string;
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  entries: GitFileChange[];
  truncated: boolean;
};

export type GitPatch = (
  | { kind: "text"; patch: string }
  | { kind: "empty" | "binary" | "too-large" | "unsupported" | "conflict" | "submodule" }
);
export type WorkspaceGitDiff = { path: string; area: GitDiffArea } & GitPatch;

export interface GitRef { name: string; hash: string; kind: "branch" | "remote" | "tag" }
export interface GitCommitSummary { hash: string; parents: string[]; author: string; authoredAt: string; subject: string }
export interface GitHistory {
  kind: WorkspaceGitStatus["kind"];
  root: string | null;
  scope: string;
  head: string | null;
  snapshot: string;
  refs: GitRef[];
  commits: GitCommitSummary[];
  nextCursor: string | null;
}
export interface GitCommitFile { path: string; status: string; additions: number | null; deletions: number | null }
export interface GitCommitDetail extends GitCommitSummary {
  message: string;
  email: string;
  committer: string;
  committerEmail: string;
  committedAt: string;
  root: string;
  scope: string;
  parentIndex: number;
  files: GitCommitFile[];
  truncated: boolean;
}
export type GitCommitDiff = { hash: string; path: string; parentIndex: number; parentHash: string | null } & GitPatch;

export type GitWriteAction = "stage" | "unstage" | "commit" | "create-branch" | "switch-branch";
export type GitWriteReason = "state_changed" | "busy" | "agent_busy" | "session_changed" | "root_required" | "operation_in_progress" | "index_locked" | "too_many_changes" | "dirty_worktree" | "nothing_staged" | "identity_missing" | "invalid_branch" | "branch_exists" | "branch_in_use" | "no_commits" | "invalid_path" | "invalid_message" | "git_failed" | "outcome_unknown";
export interface GitControlState {
  kind: WorkspaceGitStatus["kind"];
  root: string | null;
  scope: string;
  head: string | null;
  branch: string | null;
  version: string;
  staged: number;
  dirty: boolean;
  blocked: GitWriteReason | null;
  branches: { name: string; current: boolean; occupied: boolean }[];
}
export interface GitWriteResult { action: GitWriteAction; head: string | null }
