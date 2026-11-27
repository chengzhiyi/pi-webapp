const { contextBridge, ipcRenderer } = require("electron");

if (process.isMainFrame) {
  if (process.platform === "darwin" || process.platform === "win32") {
    contextBridge.exposeInMainWorld("piDesktopFileManager", {
      platform: process.platform,
      // The session tree sends a sessionId and relative path. The sidebar sends
      // a workspaceId with path "" and kind "directory" (registered root only).
      show: target => ipcRenderer.invoke("file-manager:show", target).catch(() => ({ ok: false, reason: "failed" })),
      listApps: target => ipcRenderer.invoke("file-manager:list-apps", target).catch(() => ({ ok: false, reason: "failed" })),
      openWith: (target, appId) => ipcRenderer.invoke("file-manager:open-with", target, appId).catch(() => ({ ok: false, reason: "failed" })),
    });
  }
  contextBridge.exposeInMainWorld("piWebPreview", {
    open: (id, url) => ipcRenderer.invoke("web-preview:open", id, url),
    command: (id, action) => ipcRenderer.invoke("web-preview:command", id, action),
    layout: (id, bounds) => ipcRenderer.send("web-preview:layout", id, bounds),
    close: id => ipcRenderer.send("web-preview:close", id),
    onState: callback => {
      const listener = (_event, id, state) => callback(id, state);
      ipcRenderer.on("web-preview:state", listener);
      return () => ipcRenderer.removeListener("web-preview:state", listener);
    },
  });
}
