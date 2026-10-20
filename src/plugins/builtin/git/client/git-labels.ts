import type { GitDiffArea } from "../contract/workspace-git.ts";
import { localize as t } from "../../../../../web/src/ui/locale/preference.ts";
export function gitAreaLabel(area: GitDiffArea) {
  return area === "staged" ? t("已暂存", "Staged") : area === "unstaged" ? t("未暂存", "Unstaged") : t("未跟踪", "Untracked");
}
