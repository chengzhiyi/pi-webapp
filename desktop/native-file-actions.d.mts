import type { ExecFileOptions, spawn } from "node:child_process";
import type { Stats } from "node:fs";

type Awaitable<T> = T | Promise<T>;
type Kind = "file" | "directory";

export type Operation = "show" | "list" | "open";
export type LookupTarget =
  | { sessionId: string; workspaceId?: never; segments: readonly string[]; kind: Kind }
  | { workspaceId: string; sessionId?: never; segments: readonly []; kind: "directory" };
export type AppChoice = { id: string; name: string; icon?: string; isDefault?: true };
export type Result = { ok: false; reason: "failed" | "not-found" } | { ok: true; apps?: AppChoice[] };

export interface NativeFileActionContext {
  lookupRoot(target: LookupTarget): Awaitable<string | undefined>;
  trusted(): boolean;
}

export interface NativeFileActionsOptions {
  platform?: NodeJS.Platform;
  shell?: {
    showItemInFolder(path: string): Awaitable<void | boolean>;
    openPath(path: string): Awaitable<string>;
  };
  realpath?(path: string): Awaitable<string>;
  inspect?(path: string): Awaitable<Pick<Stats, "isDirectory" | "isFile" | "dev" | "ino">>;
  macFolder?(path: string): Awaitable<boolean>;
  getApps?(platform: "darwin" | "win32"): Awaitable<{
    list(path: string, kind: Kind): Awaitable<Iterable<{ id: string; name: string; icon?: string; isDefault?: boolean }>>;
    open(path: string, nativeId: string, kind: Kind): Awaitable<void | boolean>;
  }>;
  systemRoot?: string;
  runFile?(file: string, args: string[], options: ExecFileOptions): Promise<unknown>;
  spawnProcess?: typeof spawn;
}

export type NativeFileActions = (operation: Operation, input: unknown, appId: unknown, context: NativeFileActionContext) => Promise<Result>;
export function createNativeFileActions(opts?: NativeFileActionsOptions): NativeFileActions;
