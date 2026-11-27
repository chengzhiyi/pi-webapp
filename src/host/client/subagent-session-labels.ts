import type { SubagentSessionView, WorkspaceSessionView } from "../../contracts/bridge-contract.ts";
import { localize as t } from "../../../web/src/ui/locale/preference.ts";

export function subagentStatusText(status: SubagentSessionView["status"]) {
  switch (status) {
    case "running": return t("运行中", "Running");
    case "completed": return t("已完成", "Completed");
    case "failed": return t("失败", "Failed");
    case "cancelled": return t("已取消", "Cancelled");
    case "unknown": return t("状态未知", "Status unknown");
  }
}

export const subagentTitle = (row: WorkspaceSessionView) => row.subagent?.description || (row.subagent ? t(`${row.subagent.agentType} 子任务`, `${row.subagent.agentType} task`) : row.name);