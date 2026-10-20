import { BUILTIN_IDS, type PluginMetadata } from "../../../../contracts/plugins.ts";
export const metadata: PluginMetadata = {
  id: BUILTIN_IDS.git, kind: "builtin", version: "1.0.0",
  name: { zh: "Git", en: "Git" },
  description: { zh: "审阅工作区改动与提交历史，暂存文件、提交并管理本地分支。", en: "Review workspace changes and history, stage files, commit and manage local branches." },
};
