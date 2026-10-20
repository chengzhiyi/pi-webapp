import { accessToken } from "../../../../host/client/access-token.ts";
import { bridgeFetch, bridgeJson } from "../../../../host/client/telemetry-fetch.ts";
import type { WorkspaceFileListing, WorkspaceFilePreview } from "../contract/workspace-files.ts";

async function read<T>(operation: "list" | "preview", sessionId: string, path: string, signal: AbortSignal): Promise<T> {
  return bridgeJson(await bridgeFetch(`/api/workspace/files/${operation}`, {
    method: "POST", headers: { Authorization: `Bearer ${accessToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, path }), signal,
  }));
}

export const workspaceFilesApi = {
  list: (sessionId: string, path: string, signal: AbortSignal) => read<WorkspaceFileListing>("list", sessionId, path, signal),
  preview: (sessionId: string, path: string, signal: AbortSignal) => read<WorkspaceFilePreview>("preview", sessionId, path, signal),
};
