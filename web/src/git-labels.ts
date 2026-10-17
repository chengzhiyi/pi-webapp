import type { GitDiffArea } from "../../shared/workspace-git.ts";
import { localize as t } from "./ui/locale/preference.ts";
export function gitAreaLabel(area: GitDiffArea) {
  return area === "staged" ? t("已暂存", "Staged") : area === "unstaged" ? t("未暂存", "Unstaged") : t("未跟踪", "Untracked");
}
