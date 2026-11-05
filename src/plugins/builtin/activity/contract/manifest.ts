import { BUILTIN_IDS, type PluginMetadata } from "../../../../contracts/plugins.ts";

export const metadata: PluginMetadata = {
  id: BUILTIN_IDS.activity, kind: "builtin", version: "1.0.0",
  name: { zh: "活动任务", en: "Activity" },
  description: { zh: "查看当前会话的子代理与后台任务，检查输出并停止运行中的工作。", en: "Inspect this session’s subagents and background tasks, read their output and stop running work." },
};
