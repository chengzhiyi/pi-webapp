import { gitPlugin } from "./git/server/plugin.ts";
import { filesPlugin } from "./files/server/plugin.ts";
import { createTerminalPlugin } from "./terminal/server/plugin.ts";
import { terminalTools, type TerminalToolHost } from "./terminal/server/tools.ts";
import { BUILTIN_IDS } from "../../contracts/plugins.ts";
import type { ServerPlugin } from "../../host/server/plugins/server-plugin.ts";
import type { WebInteraction } from "@chengzhiyi/pi-web-protocol";

export interface BuiltinToolHost {
  /** Run a builtin plugin's agent action; rejects while the Web bridge is closed or the plugin is disabled. */
  run(pluginId: string, cwd: string, sessionId: string, action: string, input: unknown, signal?: AbortSignal): Promise<unknown>;
  ask(request: WebInteraction, signal?: AbortSignal): Promise<unknown>;
}

/** Same definitions for the foreground extension and retained SDK sessions. */
export function builtinAgentTools(host: BuiltinToolHost) {
  const terminal: TerminalToolHost = { run: (...args) => host.run(BUILTIN_IDS.terminal, ...args), ask: host.ask };
  return terminalTools(terminal);
}

/** Drawings belong exclusively to the optional official hosted plugin. */
export function builtinServerPlugins(): ServerPlugin[] {
  return [filesPlugin, createTerminalPlugin(), gitPlugin];
}
