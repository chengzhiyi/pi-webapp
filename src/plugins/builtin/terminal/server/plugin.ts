import type { ServerResponse } from "node:http";
import type { ServerPlugin } from "../../../../host/server/plugins/server-plugin.ts";
import { metadata } from "../contract/manifest.ts";
import { TerminalRegistry } from "./terminals.ts";
import { terminalRoute } from "./terminal-routes.ts";

export function createTerminalPlugin(): ServerPlugin {
  const registry = new TerminalRegistry();
  const streams = new Set<ServerResponse>();
  const clear = async () => {
    for (const stream of streams) stream.end();
    streams.clear();
    await registry.clear();
  };
  return {
    metadata,
    routes: ["create", "attach", "input", "resize", "close"].map(action => `/api/terminal/${action}`),
    handle: context => terminalRoute(context.path, context.body, context.res, context.snapshot, registry, streams),
    restartBlocker: () => registry.size ? "请先关闭所有终端，再升级并重启后台" : null,
    disable: clear,
    async close() { await clear(); await registry.close(); },
  };
}
