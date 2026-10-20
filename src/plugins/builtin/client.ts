import type { WorkbenchPluginDefinition } from "../../contracts/workbench.ts";

/** Lazy module adapters use the same validation/activation path as external protocol-v1 plugins. */
const modules: Record<string, () => Promise<{ default: WorkbenchPluginDefinition }>> = {
  "builtin:@pi-webapp/files": () => import("./files/client/plugin.tsx"),
  "builtin:@pi-webapp/terminal": () => import("./terminal/client/plugin.tsx"),
  "builtin:@pi-webapp/git": () => import("./git/client/plugin.tsx"),
};
export function loadBuiltinPlugin(url: string) {
  const load = modules[url];
  if (!load) throw new Error("Unknown builtin plugin module");
  return load();
}
