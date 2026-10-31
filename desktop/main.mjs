import { app, autoUpdater, BrowserWindow, dialog, Menu, shell, session } from "electron";
import { access, readFile } from "node:fs/promises";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DesktopBackend, externalAddress, localAddress, sameDocument } from "./backend.mjs";
import { connectBackend } from "./connect.mjs";
import { DesktopUpdater } from "./updater.mjs";
import { configureLocalExport } from "./downloads.mjs";
import { confirmDesktopQuit } from "./quit.mjs";

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
let handingOff = false;
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
  window.webContents.setUserAgent(`${window.webContents.getUserAgent()} PiDesktop/${app.getVersion()} PiDesktopBuild/${release.buildNumber}`);
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url === "pi-desktop://launcher-handoff") { void requestLauncherHandoff(); return { action: "deny" }; }
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
    if (!askingQuit && !quitting) dialog.showErrorBox("界面进程已退出", "后台任务可能仍在运行。请使用“窗口 → 重新加载界面”，不要重复发送任务。");
  });
  window.on("close", event => {
    if (!quitting) { event.preventDefault(); void requestQuit(); }
  });
  window.on("closed", () => { window = null; });
  // Load the existing same-origin page; no Node/preload privileges are exposed to it.
  void window.loadURL(backendUrl).catch(() => {
    // Closing a loading window aborts navigation. A synchronous native alert
    // here would re-enter the macOS modal loop and block shutdown itself.
    if (!askingQuit && !quitting) dialog.showErrorBox("无法加载界面", "请查看后端日志，或重新打开应用。");
  });
}

async function openExternal(value) {
  const url = externalAddress(value);
  if (!url) return; // Never dispatch file:, javascript:, shell:, or custom OS protocols.
  if (backendUrl && new URL(url).origin === new URL(backendUrl).origin) return;
  const answer = await dialog.showMessageBox({ type: "question", title: "在浏览器中打开链接？",
    message: "此链接将交给系统默认浏览器。", detail: url, buttons: ["取消", "打开浏览器"],
    defaultId: 0, cancelId: 0, noLink: true });
  if (answer.response === 1 && !quitting) await shell.openExternal(url).catch(() => {
    if (!askingQuit && !quitting) dialog.showErrorBox("无法打开链接", "请检查默认浏览器设置。");
  });
}

function showQuitMessage(options) {
  if (window && !window.isDestroyed()) {
    window.show(); window.focus();
    return dialog.showMessageBox(window, options);
  }
  return dialog.showMessageBox(options);
}

async function requestQuit() {
  if (askingQuit || quitting) return;
  if (handingOff) { await showQuitMessage({ message: "正在安全交接后台启动器，请等待正常退出和重新连接。", buttons: ["确定"] }); return; }
  if (startup) return; // Finish acquiring ownership before permitting shutdown.
  if (updater?.busy) {
    await showQuitMessage({ message: "桌面更新正在处理，请等待下载或系统校验完成后再退出。", buttons: ["确定"] });
    return;
  }
  askingQuit = true;
  try {
    if (!await confirmDesktopQuit({ appName, backend, updater, showMessageBox: showQuitMessage })) return;
    quitting = true;
    app.quit();
  } catch (error) { dialog.showErrorBox("尚未退出", error.message); }
  finally { askingQuit = false; }
}

async function requestLauncherHandoff() {
  if (startup || quitting || askingQuit || handingOff || updater?.busy || !backend) return;
  handingOff = true;
  try {
    const answer = await showQuitMessage({ type: "question", title: "安全切换后台启动器",
      message: "将旧共享后台交接给当前桌面启动器？",
      detail: "仅在所有聊天空闲、无终端且图稿保存确认完成后进行。旧进程正常退出后，使用当前桌面运行环境和原业务包重启，保留原本地地址、图稿恢复副本和更新通道。发现运行任务或保存阻塞会中止，不会强制停止。",
      buttons: ["取消", "检查并安全交接"], defaultId: 0, cancelId: 0, noLink: true });
    if (answer.response !== 1 || quitting) return;
    const state = await backend.handoff();
    backendUrl = localAddress(state.url).href;
    await window?.loadURL(backendUrl);
    await showQuitMessage({ type: "info", message: "启动器安全交接完成",
      detail: `当前桌面 ${app.getVersion()} build ${release.buildNumber} 已启动原业务包 ${state.version}，支持持久化体验版通道。请在设置中检查更新。`, buttons: ["好"] });
  } catch (error) { await showQuitMessage({ type: "warning", message: "启动器交接未完成", detail: error.message, buttons: ["好"] }); }
  finally { handingOff = false; }
}

function installMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: appName, submenu: [
      { label: `关于 ${appName}`, click: async () => {
        await backend?.refresh().catch(() => {});
        if (askingQuit || quitting) return;
        return dialog.showMessageBox({ type: "info", message: appName,
          detail: `桌面外壳版本 ${app.getVersion()} · 桌面构建 ${release.buildNumber}\n当前 pi-webapp ${backend?.state?.version ?? "unknown"}\n随包 Pi ${bundledPiVersion}（已有共享后台仍使用其自身版本）\n应用位置：${app.getPath("exe")}\n当前连接：${backend?.owned ? "桌面自有后台" : "已有共享后台"}\n后台启动器 ${backend?.state?.launcherVersion ?? "unknown"} · 启动桌面 ${backend?.state?.desktopShell?.version ?? "unknown"} build ${backend?.state?.desktopShell?.build ?? "unknown"}\n启动器通道持久化：${backend?.state?.desktopReleaseChannels === true ? "支持" : backend?.state?.desktopReleaseChannels === false ? "不支持" : "未报告"}\n业务包通过界面设置中的“应用更新”升级；“检查桌面更新”仅更新桌面外壳安装包。` });
      } },
      { label: "安全切换到当前桌面启动器…", click: () => void requestLauncherHandoff() },
      { label: "检查桌面更新…", click: () => { if (!startup && !handingOff) void updater?.run(); } },
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
  // Device permissions remain denied; only current trusted local export blobs may download.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.on("will-download", (event, item, contents) => configureLocalExport(event, item, contents, {
    expectedContents: window?.webContents, backendUrl, downloadsPath: app.getPath("downloads"),
  }));
  updater = new DesktopUpdater({ current: { version: app.getVersion(), build: release.buildNumber },
    packaged: app.isPackaged, appPath: resolve(dirname(app.getPath("exe")), "../.."), cachePath: app.getPath("temp"),
    autoUpdater, showMessageBox: options => quitting ? Promise.resolve({ response: 0 }) : dialog.showMessageBox(options),
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
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir,
        PI_WEBAPP_DESKTOP_VERSION: app.getVersion(), PI_WEBAPP_DESKTOP_BUILD: String(release.buildNumber) } });
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
