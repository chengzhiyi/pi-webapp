import { defineWebPlugin } from "@chengzhiyi/pi-web-protocol";
import { IconGlobeOutlineRegular } from "../../../../../web/src/ui/shared/primitives/icons/index.tsx";
import type { WorkbenchPluginDefinition } from "../../../../contracts/workbench.ts";
import { desktopWebPreview } from "./desktop-api.ts";
import { PreviewModel } from "./preview-model.ts";
import { WebPreview } from "./WebPreview.tsx";
import { WEB_PREVIEW_ID } from "./metadata.ts";

const label = { zh: "网页预览", en: "Web Preview" };
const kind = "web-preview";

export default defineWebPlugin<WorkbenchPluginDefinition>({
  id: WEB_PREVIEW_ID, apiVersion: 1, activate() {},
  workbench: {
    apiVersion: 1,
    entry: { category: "workspace", kind, label, description: { zh: "在工作区打开网页", en: "Open websites in the workspace" }, icon: IconGlobeOutlineRegular },
    panels: [{ kind, component: p => {
      const api = desktopWebPreview();
      if (!api) return null;
      const model = p.resource(() => new PreviewModel(api), model => model.dispose());
      return <WebPreview model={model} visible={p.visible} locale={p.locale} />;
    } }],
  },
});
