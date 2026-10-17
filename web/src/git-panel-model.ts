import type { GitFileSelection } from "./git-file-selection.ts";
import type { GitHistory } from "../../shared/workspace-git.ts";

/** Retained by the owning Dock tab across chat switches; cleared when the tab closes. */
export interface GitPanelModel {
  selection: GitFileSelection | null;
  view: "changes" | "history";
  history: GitHistory | null;
  selected: string | null;
  message: string;
  branch: string;
  checkout: boolean;
  pending: boolean;
  outcome: { ok: boolean; reason: string } | null;
}
export const createGitPanelModel = (): GitPanelModel => ({ selection: null, view: "changes", history: null, selected: null, message: "", branch: "", checkout: true, pending: false, outcome: null });
