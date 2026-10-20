import { gitPlugin } from "./git/server/plugin.ts";
import { filesPlugin } from "./files/server/plugin.ts";
import { createTerminalPlugin } from "./terminal/server/plugin.ts";
import type { ServerPlugin } from "../../host/server/plugins/server-plugin.ts";

/** The composition root is the only host-facing list of bundled domain implementations. */
export function builtinServerPlugins(): ServerPlugin[] { return [filesPlugin, createTerminalPlugin(), gitPlugin]; }
