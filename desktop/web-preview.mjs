import { clipboard, ipcMain, session, WebContentsView } from "electron";
import { sameDocument } from "./backend.mjs";
import { allowPreviewRequest, previewAddress, previewBounds, resolvePreviewInput } from "./web-preview-policy.mjs";

const validId = id => typeof id === "string" && /^[a-zA-Z0-9_-]{1,120}$/.test(id);
const initialState = { status: "idle", url: "", canGoBack: false, canGoForward: false };

export function installWebPreviewIpc(getPreview, getBackendUrl) {
  const fromHost = (event, id) => {
    const preview = getPreview();
    const frame = event.senderFrame;
    return preview && validId(id) && event.sender === preview.host && frame && frame === preview.host.mainFrame
      && sameDocument(frame.url, getBackendUrl()) ? preview : undefined;
  };
  const requireHost = (event, id) => {
    const preview = fromHost(event, id);
    if (!preview) throw new Error("Web Preview is not available in this frame");
    return preview;
  };
  ipcMain.handle("web-preview:open", (event, id, url) => requireHost(event, id).open(id, url));
  ipcMain.handle("web-preview:command", (event, id, action) => requireHost(event, id).command(id, action));
  ipcMain.on("web-preview:layout", (event, id, bounds) => fromHost(event, id)?.layout(id, bounds));
  ipcMain.on("web-preview:close", (event, id) => fromHost(event, id)?.close(id));
}

/** The guest never sees the Pi renderer's preload, credentials, or Electron session. */
export class WebPreview {
  entries = new Map();
  attached = null;

  constructor(window, getBackendUrl, openExternal) {
    this.window = window;
    this.host = window.webContents;
    this.getBackendUrl = getBackendUrl;
    this.openExternal = openExternal;
    this.session = session.fromPartition("pi-web-preview"); // In-memory, not persist:.
    this.session.setPermissionRequestHandler((_contents, _permission, reply) => reply(false));
    this.session.setPermissionCheckHandler(() => false);
    this.session.setDevicePermissionHandler(() => false);
    this.session.setDisplayMediaRequestHandler((_request, reply) => reply({}));
    this.session.on("will-download", this.rejectDownload);
    this.session.webRequest.onBeforeRequest(({ url, resourceType }, reply) => {
      reply({ cancel: !allowPreviewRequest(url, resourceType, this.getBackendUrl()) });
    });
    // Keep Chromium's system network settings for public sites and search.
    // The request policy above checks Pi's port independently of proxy routing.
    this.host.on("did-start-navigation", event => {
      if (event.isMainFrame && !event.isSameDocument) this.clear();
    });
    this.host.on("render-process-gone", () => this.clear());
    this.host.once("destroyed", () => this.dispose());
    window.on("resize", () => { if (this.attached) this.syncView(this.attached); });
  }

  rejectDownload = event => event.preventDefault();

  open(id, value) {
    const normalized = resolvePreviewInput(value);
    const url = normalized && previewAddress(normalized, this.getBackendUrl());
    let entry = this.entries.get(id);
    if (!entry) {
      entry = { id, state: initialState, view: null, bounds: null, requestedUrl: "", revision: 0 };
      this.entries.set(id, entry);
    }
    if (!url) {
      entry.revision++;
      entry.view?.webContents.stop();
      this.update(entry, "failed", "", normalized ? "navigation" : "address");
    } else this.load(entry, url);
    return entry.state;
  }

  command(id, action) {
    const entry = this.entries.get(id);
    if (!entry) return initialState;
    const url = previewAddress(entry.state.url, this.getBackendUrl());
    if (action === "copy" && url) clipboard.writeText(url);
    if (action === "external" && url) void this.openExternal(url);
    if (action === "reload" && url) this.load(entry, url, true);
    if (action === "back" || action === "forward") {
      const index = this.historyIndex(entry, action === "back" ? -1 : 1);
      if (index !== null) entry.view.webContents.navigationHistory.goToIndex(index);
    }
    return entry.state;
  }

  historyIndex(entry, step) {
    const history = entry.view?.webContents.navigationHistory;
    if (!history) return null;
    const index = history.getActiveIndex() + step;
    return index >= 0 && index < history.length() && previewAddress(history.getEntryAtIndex(index)?.url, this.getBackendUrl()) ? index : null;
  }

  layout(id, bounds) {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.bounds = bounds;
    this.syncView(entry);
  }

  syncView(entry) {
    if (this.window.isDestroyed() || this.host.isDestroyed()) return;
    const bounds = entry.view && entry.state.status === "ready" &&
      previewBounds(entry.bounds, this.window.getContentBounds(), this.host.getZoomFactor());
    if (!bounds) { this.detach(entry); return; }
    entry.view.setBounds(bounds);
    if (this.attached !== entry) {
      if (this.attached) this.detach(this.attached);
      this.window.contentView.addChildView(entry.view);
      this.attached = entry;
    }
  }

  detach(entry) {
    if (this.attached !== entry) return;
    this.attached = null;
    if (this.window.isDestroyed()) return;
    const contents = entry.view.webContents;
    const focused = !contents.isDestroyed() && contents.isFocused();
    this.window.contentView.removeChildView(entry.view);
    if (focused && !this.host.isDestroyed()) this.host.focus();
  }

  update(entry, status, url, error) {
    if (this.entries.get(entry.id) !== entry) return;
    entry.state = { status, url, canGoBack: this.historyIndex(entry, -1) !== null,
      canGoForward: this.historyIndex(entry, 1) !== null, ...(error ? { error } : {}) };
    this.syncView(entry);
    if (!this.host.isDestroyed()) this.host.send("web-preview:state", entry.id, entry.state);
  }

  load(entry, url, reload = false) {
    entry.requestedUrl = url;
    const revision = ++entry.revision;
    this.update(entry, "loading", url);
    void Promise.resolve().then(async () => {
      if (this.entries.get(entry.id) !== entry || entry.revision !== revision) return;
      if (!previewAddress(url, this.getBackendUrl())) { this.update(entry, "failed", url, "navigation"); return; }
      const contents = (entry.view ?? this.createView(entry)).webContents;
      if (reload && contents.getURL() === url && contents.navigationHistory.getActiveIndex() >= 0) {
        contents.reloadIgnoringCache();
      } else await contents.loadURL(url);
    }).catch(() => {
      if (entry.revision === revision && entry.state.status === "loading") this.update(entry, "failed", entry.requestedUrl, "load");
    });
  }

  createView(entry) {
    const view = new WebContentsView({ webPreferences: {
      session: this.session, nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false, spellcheck: false, disableDialogs: true,
    } });
    entry.view = view;
    const contents = view.webContents;
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-attach-webview", event => event.preventDefault());
    const guard = event => {
      const allowed = event.isMainFrame ? previewAddress(event.url, this.getBackendUrl())
        : allowPreviewRequest(event.url, "subFrame", this.getBackendUrl());
      if (allowed) return;
      event.preventDefault();
      if (event.isMainFrame) this.update(entry, "failed", entry.requestedUrl, "navigation");
    };
    contents.on("will-frame-navigate", guard);
    contents.on("will-redirect", guard);
    contents.on("did-start-navigation", event => {
      if (!event.isMainFrame || event.isSameDocument) return;
      const url = previewAddress(event.url, this.getBackendUrl());
      if (!url) return;
      entry.requestedUrl = url;
      this.update(entry, "loading", url);
    });
    const finished = () => {
      const url = previewAddress(contents.getURL(), this.getBackendUrl());
      if (url && entry.state.status !== "failed") {
        entry.requestedUrl = url;
        this.update(entry, "ready", url);
      }
    };
    contents.on("did-finish-load", finished);
    contents.on("did-navigate-in-page", (_event, _url, mainFrame) => { if (mainFrame) finished(); });
    contents.on("did-fail-load", (_event, code, _message, url, mainFrame) => {
      if (mainFrame && code !== -3 && entry.state.status === "loading") {
        this.update(entry, "failed", previewAddress(url, this.getBackendUrl()) ?? entry.requestedUrl, "load");
      }
    });
    contents.on("render-process-gone", () => {
      this.destroyView(entry);
      this.update(entry, "failed", entry.requestedUrl, "load");
    });
    return view;
  }

  destroyView(entry) {
    this.detach(entry);
    const contents = entry.view?.webContents;
    entry.view = null;
    if (contents && !contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
  }

  close(id) {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.destroyView(entry);
  }

  clear() { for (const id of this.entries.keys()) this.close(id); }

  dispose() {
    this.clear();
    this.session.removeListener("will-download", this.rejectDownload);
  }
}
