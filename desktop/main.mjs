import { app, autoUpdater, BrowserWindow, dialog, Menu, shell, session } from "electron";
import { access, readFile } from "node:fs/promises";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DesktopBackend, externalAddress, localAddress, sameDocument } from "./backend.mjs";
import { connectBackend } from "./connect.mjs";
import { DesktopUpdater } from "./updater.mjs";

const iconPath = fileURLToPath(new URL("./icons/icon.png", import.meta.url));
const release = JSON.parse(readFileSync(new URL("./release.json", import.meta.url), "utf8"));
const appName = release.productName;
// Keep the pre-rename Electron profile/instance lock, but respect isolated test profiles.
if (!app.commandLine.hasSwitch("user-data-dir")) {
  const profile = join(app.getPath("appData"), "Pi Webapp");
  mkdirSync(profile, { recursive: true });
  app.setPath("userData", profile);
}
app.setName(appName);
const locked = app.requestSingleInstanceLock();
let window;
let backend;
let backendUrl;
let updater;
let bundledPiVersion = "unknown";
let quitting = false;
let askingQuit = false;
let startup = true;

function showWindow() {
  if (!backendUrl || quitting) return;
  if (window && !window.isDestroyed()) { window.show(); window.focus(); return; }
  window = new BrowserWindow({ width: 1360, height: 900, minWidth: 720, minHeight: 480,
    title: appName, icon: iconPath, backgroundColor: "#faf9f6", show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false, spellcheck: false } });
  // The shared Web document may retain its own branding; keep the native app title pi.
  window.on("page-title-updated", event => event.preventDefault());
  window.once("ready-to-show", () => window?.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    void openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!sameDocument(url, backendUrl)) { event.preventDefault(); void openExternal(url); }
  });
  window.webContents.on("will-redirect", (event, url) => {
    if (!sameDocument(url, backendUrl)) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", event => event.preventDefault());
  window.webContents.on("render-process-gone", () => {
    dialog.showErrorBox("界面进程已退出", "后台任务可能仍在运行。请使用“窗口 → 重新加载界面”，不要重复发送任务。");
  });
  window.on("close", event => {
    if (!quitting) { event.preventDefault(); void requestQuit(); }
  });
  window.on("closed", () => { window = null; });
  // Load the existing same-origin page; no Node/preload privileges are exposed to it.
  void window.loadURL(backendUrl).catch(() => dialog.showErrorBox("无法加载界面", "请查看后端日志，或重新打开应用。"));
}

async function openExternal(value) {
  const url = externalAddress(value);
  if (!url) return; // Never dispatch file:, javascript:, shell:, or custom OS protocols.
  if (backendUrl && new URL(url).origin === new URL(backendUrl).origin) return;
  const answer = await dialog.showMessageBox({ type: "question", title: "在浏览器中打开链接？",
    message: "此链接将交给系统默认浏览器。", detail: url, buttons: ["取消", "打开浏览器"],
    defaultId: 0, cancelId: 0, noLink: true });
  if (answer.response === 1) await shell.openExternal(url).catch(() => dialog.showErrorBox("无法打开链接", "请检查默认浏览器设置。"));
}

async function requestQuit() {
  if (askingQuit || quitting) return;
  if (startup) return; // Finish acquiring ownership before permitting shutdown.
  if (updater?.busy) {
    await dialog.showMessageBox({ message: "桌面更新正在处理，请等待下载或系统校验完成后再退出。", buttons: ["确定"] });
    return;
  }
  askingQuit = true;
  try {
    await updater?.assertQuitSafe(); // A native-staged update may install on normal exit.
    if (backend?.owned) {
      const answer = await dialog.showMessageBox({ type: "warning", title: `退出 ${appName}`,
        message: "是否同时停止后台服务？",
        detail: "停止服务将结束所有聊天的运行任务和终端，也会断开正在使用该服务的浏览器。继续后台运行后，可重新打开桌面应用或使用 pi-webapp stop 停止。",
        buttons: ["取消", "仅关窗口，后台继续", "停止服务并退出"], defaultId: 0, cancelId: 0, noLink: true });
      if (answer.response === 0) return;
      if (answer.response === 2) await backend.stop();
    } else if (backend) {
      const answer = await dialog.showMessageBox({ type: "info", title: "关闭桌面应用",
        message: "当前连接的是已有服务，关闭桌面不会停止它。", buttons: ["取消", "关闭桌面"], defaultId: 0, cancelId: 0 });
      if (answer.response !== 1) return;
    }
    quitting = true;
    app.quit();
  } catch (error) { dialog.showErrorBox("尚未退出", error.message); }
  finally { askingQuit = false; }
}

function installMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: appName, submenu: [
      { label: `关于 ${appName}`, click: () => dialog.showMessageBox({ type: "info", message: appName,
        detail: `版本 ${app.getVersion()} · 桌面构建 ${release.buildNumber}\n随包 Pi ${bundledPiVersion}（已有共享后台仍使用其自身版本）\n应用位置：${app.getPath("exe")}\n当前连接：${backend?.owned ? "桌面自有后台" : "已有共享后台"}\n桌面版与 Web 共用界面和后端。请通过“检查桌面更新”获取桌面安装包。` }) },
      { label: "检查桌面更新…", click: () => { if (!startup) void updater?.run(); } },
      { label: "取消桌面更新下载", click: () => updater?.cancelDownload() },
      { type: "separator" }, { label: "退出…", accelerator: "CmdOrCtrl+Q", click: () => void requestQuit() },
    ] },
    { label: "编辑", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" },
      { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    { label: "窗口", submenu: [
      { label: "显示主窗口", click: showWindow },
      { label: "重新加载界面", accelerator: "CmdOrCtrl+R", click: () => window?.webContents.reload() },
      { role: "togglefullscreen" },
      { label: "在浏览器中打开", click: () => { if (backendUrl) void shell.openExternal(backendUrl); } },
      { label: "打开日志目录", click: () => { if (backend) void shell.openPath(dirname(backend.logPath)); } },
    ] },
  ]));
}

if (!locked) app.quit();
else {
  app.on("second-instance", showWindow);
  app.on("activate", showWindow);
  app.on("before-quit", event => { if (!quitting) { event.preventDefault(); void requestQuit(); } });
  app.on("window-all-closed", () => { if (!startup && !quitting) void requestQuit(); });
  // Let the ESM entry finish evaluating before Electron emits ready.
  void app.whenReady().then(async () => {
  // Packaged macOS uses the bundle's ICNS; development otherwise inherits Electron's Dock icon.
  if (!app.isPackaged && process.platform === "darwin") app.dock.setIcon(iconPath);
  // No permissions, device capture, downloads or child windows are needed by the shared UI.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.on("will-download", event => event.preventDefault());
  updater = new DesktopUpdater({ current: { version: app.getVersion(), build: release.buildNumber },
    packaged: app.isPackaged, appPath: resolve(dirname(app.getPath("exe")), "../.."), cachePath: app.getPath("temp"),
    autoUpdater, showMessageBox: options => dialog.showMessageBox(options),
    openExternal: url => shell.openExternal(url), revealFile: path => shell.showItemInFolder(path),
    getBackend: () => { if (!backend) throw new Error("后台身份尚未确认，请稍后重试安装"); return backend; },
    setProgress: value => window?.setProgressBar(value),
    beforeInstall: () => { const wasStarting = startup; startup = false; quitting = true;
      return () => { startup = wasStarting; quitting = false; }; } });
  installMenu(); // Updates must remain reachable even when backend versions differ.
  try {
    const runtime = app.isPackaged ? join(process.resourcesPath, "runtime")
      : fileURLToPath(new URL("../.desktop/runtime", import.meta.url));
    const packageRoot = join(runtime, "backend");
    const pkg = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    bundledPiVersion = pkg.dependencies["@earendil-works/pi-coding-agent"];
    const nodeRoot = join(runtime, "node");
    const node = process.platform === "win32" ? join(nodeRoot, "node.exe") : join(nodeRoot, "bin", "node");
    const npmCli = join(nodeRoot, process.platform === "win32" ? "node_modules" : "lib/node_modules", "npm", "bin", "npm-cli.js");
    const piCli = join(packageRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
    await Promise.all([node, npmCli, piCli, join(packageRoot, "dist", "extension.js")].map(path => access(path)));
    const agentDir = resolve((process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent")).replace(/^~(?=$|[\\/])/, homedir()));
    backend = new DesktopBackend({ agentDir, version: pkg.version, node, npmCli, piCli,
      launcher: join(packageRoot, "bin", "pi-webapp.mjs"), cwd: homedir(),
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } });
    const state = await connectBackend(backend, {
      showMessageBox: options => dialog.showMessageBox(options), openExternal: url => shell.openExternal(url),
      checkDesktopUpdates: () => updater.run(), isInstalling: () => quitting || updater.nativeAttempted,
    });
    if (!state) { if (!quitting) { startup = false; quitting = true; app.exit(0); } return; }
    backendUrl = localAddress(state.url).href;
    startup = false;
    installMenu();
    showWindow();
    if (process.env.PI_WEBAPP_DESKTOP_UPDATE_CHECK !== "manual") void updater.run({ silent: true });
  } catch (error) {
    startup = false;
    dialog.showErrorBox(`${appName} 启动失败`,  `${error.code === "ENOENT" ? "缺少桌面运行环境，请先运行 npm run desktop:prepare 或重新安装桌面应用。" : error.message}\n\n${backend ? `日志：${backend.logPath}` : ""}`);
    quitting = true;
    app.exit(1);
  }
  });
}
