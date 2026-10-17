import type { GitControlState, GitWriteAction, GitWriteResult, GitCommitDetail, GitCommitDiff, GitDiffArea, GitHistory, WorkspaceGitDiff, WorkspaceGitStatus } from "../../shared/workspace-git.ts";
import { accessToken } from "./access-token.ts";
import { bridgeFetch, bridgeJson } from "./telemetry-fetch.ts";

async function read<T>(operation: string, sessionId: string, input: object, signal?: AbortSignal): Promise<T> {
  return bridgeJson(await bridgeFetch(`/api/workspace/git/${operation}`, {
    method: "POST", headers: { Authorization: `Bearer ${accessToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, ...input }), signal,
  }));
}

export const workspaceGitApi = {
  control: (sessionId: string, signal: AbortSignal) => read<GitControlState>("control", sessionId, {}, signal),
  write: (sessionId: string, input: { action: GitWriteAction; expected: string; path?: string; message?: string; branch?: string; checkout?: boolean }) => read<GitWriteResult>("write", sessionId, input),
  status: (sessionId: string, signal: AbortSignal) => read<WorkspaceGitStatus>("status", sessionId, {}, signal),
  diff: (sessionId: string, path: string, area: GitDiffArea, signal: AbortSignal) => read<WorkspaceGitDiff>("diff", sessionId, { path, area }, signal),
  history: (sessionId: string, cursor: string | undefined, signal: AbortSignal) => read<GitHistory>("history", sessionId, { cursor }, signal),
  commit: (sessionId: string, hash: string, parentIndex: number, signal: AbortSignal) => read<GitCommitDetail>("commit-detail", sessionId, { hash, parentIndex }, signal),
  commitDiff: (sessionId: string, hash: string, path: string, parentIndex: number, signal: AbortSignal) => read<GitCommitDiff>("commit-diff", sessionId, { hash, path, parentIndex }, signal),
};
