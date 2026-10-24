import type { PluginMetadata } from "../../../../contracts/plugins.ts";
import { DIAGRAM_PLUGIN } from "./diagrams.ts";
export const metadata: PluginMetadata = {
  id: DIAGRAM_PLUGIN, kind: "builtin", version: "1.0.0",
  name: { zh: "手绘图", en: "Diagrams" },
  description: { zh: "Agent 生成流程与架构图，使用 Excalidraw 编辑、本地保存和导出。", en: "Generate flowcharts with the agent, edit in Excalidraw, save locally and export." },
};
