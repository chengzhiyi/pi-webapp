import { BUILTIN_IDS, type PluginMetadata } from "../../../../contracts/plugins.ts";
export const metadata: PluginMetadata = {
  id: BUILTIN_IDS.files, kind: "builtin", version: "1.0.0",
  name: { zh: "工作区文件", en: "Workspace files" },
  description: { zh: "浏览工作区目录，只读预览代码、Markdown 与图片。", en: "Browse workspace directories and preview code, Markdown and images read-only." },
};
