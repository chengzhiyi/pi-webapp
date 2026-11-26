import type { SubagentNotice } from "../../contracts/bridge-contract.ts";
import { localize as t } from "../../../web/src/ui/locale/preference.ts";

export function subagentNoticeText({ status, description }: SubagentNotice): string {
  const label = status === "completed" ? t("子代理已完成", "Subagent completed")
    : status === "failed" ? t("子代理执行失败", "Subagent failed")
    : status === "cancelled" ? t("子代理已取消", "Subagent cancelled")
    : t("子代理任务更新", "Subagent task update");
  return description ? `${label}${t("：", ": ")}${description}` : label;
}
