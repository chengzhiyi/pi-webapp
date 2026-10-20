import { BUILTIN_IDS, type PluginMetadata } from "../../../../contracts/plugins.ts";
export const metadata: PluginMetadata = {
  id: BUILTIN_IDS.terminal, kind: "builtin", version: "1.0.0",
  name: { zh: "终端", en: "Terminal" },
  description: { zh: "在工作区运行交互式 Shell。停用会结束此服务的所有终端进程。", en: "Run an interactive shell in the workspace. Disabling ends all terminals on this service." },
};
