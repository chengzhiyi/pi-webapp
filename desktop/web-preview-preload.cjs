const { contextBridge, ipcRenderer } = require("electron");

if (process.isMainFrame) {
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
