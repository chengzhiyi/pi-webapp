import type { ServerResponse } from "node:http";
import type { SessionView } from "../../../contracts/bridge-contract.ts";
import type { PluginMetadata } from "../../../contracts/plugins.ts";

export interface PluginRequestContext {
  path: string;
  body: { sessionId: string } & Record<string, unknown>;
  res: ServerResponse;
  snapshot(): SessionView;
  busyWorkspaces(): string[];
  json(status: number, value: unknown): void;
}
/** Authentication and JSON parsing are host-owned; domain processing and teardown are plugin-owned. */
export interface ServerPlugin {
  metadata: PluginMetadata;
  routes: readonly string[];
  handle(context: PluginRequestContext): Promise<void>;
  /** Coordinate agent starts against capability mutations without importing domain internals into transport. */
  coordinateStart?<T>(cwd: string, operation: () => Promise<T>): Promise<T>;
  requestFailure?(error: unknown): { status: number; body: { error: string; errorCode: string; reason: string } } | null;
  /** Explain why restarting the shared backend would interrupt live resources. */
  restartBlocker?(): string | null;
  disable?(): Promise<void>;
  close?(): Promise<void>;
}
