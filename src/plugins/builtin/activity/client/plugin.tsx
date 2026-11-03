import { defineWebPlugin } from "@chengzhiyi/pi-web-protocol";
import type { WorkbenchPluginDefinition } from "../../../../contracts/workbench.ts";
import { IconChecklistOutlineRegular } from "../../../../../web/src/ui/shared/primitives/icons/index.tsx";
import { metadata } from "../contract/manifest.ts";
import { WorkspaceActivity } from "./WorkspaceActivity.tsx";

export default defineWebPlugin<WorkbenchPluginDefinition>({
  id: metadata.id, apiVersion: 1, activate() {},
  workbench: {
    apiVersion: 1,
    entry: { label: metadata.name, panelTitle: { zh: "任务", en: "Tasks" }, description: metadata.description, kind: "activity", icon: IconChecklistOutlineRegular },
    panels: [
      { kind: "activity", component: p => <WorkspaceActivity key={p.session.sessionId} sessionId={p.session.sessionId} visible={p.visible} /> },
    ],
  },
});
