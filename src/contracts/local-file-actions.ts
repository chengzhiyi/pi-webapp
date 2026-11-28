export type FileActionPlatform = "darwin" | "win32";
export type SessionFileTarget = { sessionId: string; path: string; kind: "file" | "directory" };
export type WorkspaceFileTarget = { workspaceId: string; path: ""; kind: "directory" };
export type FileActionTarget = SessionFileTarget | WorkspaceFileTarget;
export type FileActionFailure = { ok: false; reason: "not-found" | "failed" };
export type FileActionResult = { ok: true } | FileActionFailure;
export interface SystemFileApp { id: string; name: string; icon?: string; isDefault?: boolean }
export type ListFileAppsResult = { ok: true; apps: SystemFileApp[] } | FileActionFailure;
export const localFileActionRoute = "/api/local-file-actions";
export const localFileActionHeader = "X-Pi-Local-Files";
