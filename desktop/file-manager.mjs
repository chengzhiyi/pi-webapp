import { localAddress, sameDocument } from "./backend.mjs";
import { createNativeFileActions } from "./native-file-actions.mjs";

async function lookupBackendRoot(backendUrl, target, fetcher) {
  const backend = localAddress(backendUrl);
  const endpoint = target.sessionId ? "/api/session" : "/api/workspaces";
  const response = await fetcher(new URL(endpoint, backend), {
    method: "GET", headers: { Authorization: `Bearer ${backend.hash.slice(1)}` },
    redirect: "error", signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("Backend lookup failed");
  const data = await response.json();
  if (target.sessionId) {
    if (typeof data?.sessionId !== "string" || typeof data.cwd !== "string") throw new Error("Invalid session snapshot");
    return data.sessionId === target.sessionId ? data.cwd : undefined;
  }
  if (!Array.isArray(data?.items)) throw new Error("Invalid workspace listing");
  const item = data.items.find(row => row?.id === target.workspaceId);
  return item?.available === false ? undefined : item?.path;
}

export function installFileManagerIpc({ ipcMain, shell, getContents, getBackendUrl, platform = process.platform, fetcher = fetch,
  realpath, inspect, macFolder, getApps }) {
  if (platform !== "darwin" && platform !== "win32") return;
  const act = createNativeFileActions({ platform, shell, realpath, inspect, macFolder, getApps });
  const handle = operation => async (event, input, appId) => {
    try {
      const contents = getContents();
      const backendUrl = getBackendUrl();
      const frame = event.senderFrame;
      const trusted = () => Boolean(contents && contents === getContents() && !contents.isDestroyed() && event.sender === contents
        && frame && frame === event.senderFrame && frame === contents.mainFrame && backendUrl && backendUrl === getBackendUrl()
        && sameDocument(frame.url, backendUrl));
      return await act(operation, input, appId, { lookupRoot: target => lookupBackendRoot(backendUrl, target, fetcher), trusted });
    } catch (error) {
      return { ok: false, reason: error?.code === "ENOENT" || error?.code === "ENOTDIR" ? "not-found" : "failed" };
    }
  };
  ipcMain.handle("file-manager:show", handle("show"));
  ipcMain.handle("file-manager:list-apps", handle("list"));
  ipcMain.handle("file-manager:open-with", handle("open"));
}
