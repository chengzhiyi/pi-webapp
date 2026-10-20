import type { GitDiffArea, GitFileChange } from "../contract/workspace-git.ts";
export interface GitFileSelection { path: string; area: GitDiffArea }
/** Keep the chosen side when it exists; follow a staging transition, never another file. */
export function reconcileGitSelection(selection: GitFileSelection | null, entries: GitFileChange[]): GitFileSelection | null {
  if (!selection) return null;
  const file = entries.find(entry => entry.path === selection.path);
  if (!file) return null;
  const areas: GitDiffArea[] = file.conflict ? ["unstaged"] : file.untracked ? ["untracked"] : [
    ...(file.worktree !== "." ? ["unstaged" as const] : []), ...(file.index !== "." ? ["staged" as const] : []),
  ];
  if (areas.includes(selection.area)) return selection;
  return areas[0] ? { path: selection.path, area: areas[0] } : null;
}
