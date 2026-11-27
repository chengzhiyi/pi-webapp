import type { WorkbenchPluginDefinition } from "../../contracts/workbench.ts";
import { desktopWebPreview } from "./web-preview/client/desktop-api.ts";
import { WEB_PREVIEW_ID } from "./web-preview/client/metadata.ts";

const previewModule = `builtin:${WEB_PREVIEW_ID}`;
export { WEB_PREVIEW_ID, desktopWebPreview };

/** Lazy module adapters use the same validation/activation path as external protocol-v1 plugins. */
const modules: Record<string, () => Promise<{ default: WorkbenchPluginDefinition }>> = {
  "builtin:@pi-webapp/files": () => import("./files/client/plugin.tsx"),
  "builtin:@pi-webapp/terminal": () => import("./terminal/client/plugin.tsx"),
  "builtin:@pi-webapp/git": () => import("./git/client/plugin.tsx"),
  [previewModule]: () => import("./web-preview/client/plugin.tsx"),
};
export function loadBuiltinPlugin(url: string) {
  const load = modules[url];
  if (!load) throw new Error("Unknown builtin plugin module");
  return load();
}

/** Renderer-only contributions are not advertised by the workspace server. */
export async function loadDesktopWorkbenchPlugin() {
  if (!desktopWebPreview()) return;
  const { default: definition } = await loadBuiltinPlugin(previewModule);
  return { id: definition.id, definition };
}
