import { memo, useCallback } from "react";
import type { GitDiffArea } from "../contract/workspace-git.ts";
import { useLocale } from "../../../../../web/src/ui/locale/preference.ts";
import { gitAreaLabel } from "./git-labels.ts";
import { workspaceGitApi } from "./workspace-git-api.ts";
import { useWorkspaceGit } from "./use-workspace-git.ts";
import { GitDiffView } from "./GitDiffView.tsx";

export const WorkspaceGitDiff = memo(function WorkspaceGitDiff({ sessionId, path, area, visible, idle, onClose }: {
  sessionId: string; path: string; area: GitDiffArea; visible: boolean; idle: boolean; onClose?(): void;
}) {
  useLocale();
  const read = useCallback((signal: AbortSignal) => workspaceGitApi.diff(sessionId, path, area, signal), [sessionId, path, area]);
  const result = useWorkspaceGit(read, visible, idle);
  return <GitDiffView path={path} label={gitAreaLabel(area)} onClose={onClose} {...result} />;
});
