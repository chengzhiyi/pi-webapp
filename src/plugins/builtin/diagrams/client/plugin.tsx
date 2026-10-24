import { defineWebPlugin } from "@chengzhiyi/pi-web-protocol";
import type { WorkbenchPluginDefinition } from "../../../../contracts/workbench.ts";
import { metadata } from "../contract/manifest.ts";
import { DiagramEditor, DiagramWorkspace } from "./DiagramPanel.tsx";
import { DiagramToolView } from "./DiagramPreview.tsx";
import { flushDiagramModels } from "./model.ts";
import { ExcalidrawIcon } from "../../../../../web/src/ui/primitives/ExcalidrawIcon.tsx";
export default defineWebPlugin<WorkbenchPluginDefinition>({
  id: metadata.id, apiVersion: 1, activate() {},
  workbench: {
    apiVersion: 1,
    entry: { label: "Excalidraw", description: { zh: "手绘画布", en: "Hand-drawn canvas" }, kind: "diagrams", icon: ExcalidrawIcon },
    panels: [{ kind: "diagrams", component: DiagramWorkspace }, { kind: "diagram", component: DiagramEditor }],
    toolViews: [{ tools: ["excalidraw_create_view", "diagram_create", "diagram_patch"], component: DiagramToolView }],
    beforeSend: flushDiagramModels,
    resolvePanel: panelId => /^diagram:[\w-]{1,80}$/.test(panelId) ? { kind: "diagram", contentId: panelId.slice(8), title: "Excalidraw" } : null,
  },
});
