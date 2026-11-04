import { BUILTIN_IDS, type PluginMetadata } from "../../../../contracts/plugins.ts";
export const metadata: PluginMetadata = {
  id: BUILTIN_IDS.files, kind: "builtin", version: "1.0.0",
  name: { zh: "工作区文件", en: "Workspace files" },
  description: { zh: "浏览、搜索工作区文件，预览代码、Markdown 与图片，并编辑文本文件。", en: "Browse and search workspace files, preview code, Markdown and images, and edit text files." },
};
