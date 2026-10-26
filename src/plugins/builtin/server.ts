import { gitPlugin } from "./git/server/plugin.ts";
import { filesPlugin } from "./files/server/plugin.ts";
import { createTerminalPlugin } from "./terminal/server/plugin.ts";
import type { ServerPlugin } from "../../host/server/plugins/server-plugin.ts";

/** Drawings belong exclusively to the optional official hosted plugin. */
export function builtinServerPlugins(): ServerPlugin[] {
  return [filesPlugin, createTerminalPlugin(), gitPlugin];
}
