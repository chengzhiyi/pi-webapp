import { accessToken } from "../../../../host/client/access-token.ts";
import { bridgeFetch, bridgeJson } from "../../../../host/client/telemetry-fetch.ts";
import type { WorkspaceFileListing, WorkspaceFilePreview, WorkspaceFileSearch, WorkspaceFileStatus, WorkspaceFileWrite } from "../contract/workspace-files.ts";

async function read<T>(operation: "list" | "preview" | "write" | "status" | "search", sessionId: string, body: object, signal?: AbortSignal): Promise<T> {
  return bridgeJson(await bridgeFetch(`/api/workspace/files/${operation}`, {
    method: "POST", headers: { Authorization: `Bearer ${accessToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, ...body }), signal,
  }));
}

async function raw(sessionId: string, path: string, signal: AbortSignal): Promise<Blob> {
  const result = await bridgeFetch("/api/workspace/files/raw", {
    method: "POST", headers: { Authorization: `Bearer ${accessToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, path }), signal,
  });
  if (!result.response.ok) return bridgeJson(result);
  return result.response.blob();
}

export const workspaceFilesApi = {
  raw,
  list: (sessionId: string, path: string, signal: AbortSignal) => read<WorkspaceFileListing>("list", sessionId, { path }, signal),
  preview: (sessionId: string, path: string, signal: AbortSignal) => read<WorkspaceFilePreview>("preview", sessionId, { path }, signal),
  write: (sessionId: string, path: string, text: string, version: string) => read<WorkspaceFileWrite>("write", sessionId, { path, text, version }),
  status: (sessionId: string, signal: AbortSignal) => read<WorkspaceFileStatus>("status", sessionId, {}, signal),
  search: (sessionId: string, query: string, mode: "name" | "content", signal: AbortSignal) => read<WorkspaceFileSearch>("search", sessionId, { query, mode }, signal),
};
