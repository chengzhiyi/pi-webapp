import { app, autoUpdater, BrowserWindow, clipboard, dialog, Menu, shell, session } from "electron";
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
import { showContextMenu } from "./context-menu.mjs";
import { docsUrl, isDocsAddress, issuesUrl } from "./docs-links.mjs";
import { localize as t, setDesktopLocale } from "./locale.mjs";

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
let resetting = false;
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
  window.webContents.on("context-menu", (_event, params) => showContextMenu(params, { Menu, clipboard, window }));
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
    if (!askingQuit && !quitting) dialog.showErrorBox(t("界面进程已退出", "Renderer process exited"), t("后台任务可能仍在运行。请使用“窗口 → 重新加载界面”，不要重复发送任务。", "Background tasks may still be running. Use Window → Reload Interface; do not resend tasks."));
  });
  window.on("close", event => {
    if (!quitting) { event.preventDefault(); void requestQuit(); }
  });
  window.on("closed", () => { window = null; });
  // Load the existing same-origin page; no Node/preload privileges are exposed to it.
  void window.loadURL(backendUrl).catch(() => {
    // Closing a loading window aborts navigation. A synchronous native alert
    // here would re-enter the macOS modal loop and block shutdown itself.
    if (!askingQuit && !quitting) dialog.showErrorBox(t("无法加载界面", "Could not load the interface"), t("请查看后端日志，或重新打开应用。", "Check the backend logs or reopen the app."));
  });
}

async function openExternal(value) {
  const url = externalAddress(value);
  if (!url) return; // Never dispatch file:, javascript:, shell:, or custom OS protocols.
  if (backendUrl && new URL(url).origin === new URL(backendUrl).origin) return;
  if (!isDocsAddress(url)) {
    const answer = await dialog.showMessageBox({ type: "question", title: t("在浏览器中打开链接？", "Open link in browser?"),
      message: t("此链接将交给系统默认浏览器。", "This link will open in your default browser."), detail: url, buttons: [t("取消", "Cancel"), t("打开浏览器", "Open Browser")],
      defaultId: 0, cancelId: 0, noLink: true });
    if (answer.response !== 1) return;
  }
  await openInBrowser(url);
}

async function openInBrowser(url) {
  if (quitting) return;
  await shell.openExternal(url).catch(() => {
    if (!askingQuit && !quitting) dialog.showErrorBox(t("无法打开链接", "Could not open link"), t("请检查默认浏览器设置。", "Check your default browser settings."));
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
  if (handingOff) { await showQuitMessage({ message: t("正在安全交接后台启动器，请等待正常退出和重新连接。", "The backend launcher is being handed off safely. Wait for it to exit and reconnect."), buttons: [t("确定", "OK")] }); return; }
  if (resetting) { await showQuitMessage({ message: t("正在清理升级状态并重启后台，请稍候。", "Resetting update state and restarting the backend. Please wait."), buttons: [t("确定", "OK")] }); return; }
  if (startup) return; // Finish acquiring ownership before permitting shutdown.
  if (updater?.busy) {
    await showQuitMessage({ message: t("桌面更新正在处理，请等待下载或系统校验完成后再退出。", "A desktop update is in progress. Wait for the download or system verification to finish before quitting."), buttons: [t("确定", "OK")] });
    return;
  }
  askingQuit = true;
  try {
    if (!await confirmDesktopQuit({ appName, backend, updater, showMessageBox: showQuitMessage })) return;
    quitting = true;
    app.quit();
  } catch (error) { dialog.showErrorBox(t("尚未退出", "Could Not Quit"), error.message); }
  finally { askingQuit = false; }
}

async function requestLauncherHandoff() {
  if (startup || quitting || askingQuit || handingOff || resetting || updater?.busy || !backend) return;
  handingOff = true;
  try {
    const answer = await showQuitMessage({ type: "question", title: t("安全切换后台启动器", "Switch Backend Launcher Safely"),
      message: t("将旧共享后台交接给当前桌面启动器？", "Hand off the existing shared backend to the current desktop launcher?"),
      detail: t("仅在所有聊天空闲、无终端且图稿保存确认完成后进行。旧进程正常退出后，使用当前桌面运行环境和原业务包重启，保留原本地地址、图稿恢复副本和更新通道。发现运行任务或保存阻塞会中止，不会强制停止。", "This only proceeds when all chats are idle, no terminals are running, and drawing saves are confirmed. After the old process exits normally, it restarts with the current desktop runtime and existing app package, preserving the local address, drawing recovery copies, and update channel. Running tasks or pending saves abort the handoff; nothing is forcibly stopped."),
      buttons: [t("取消", "Cancel"), t("检查并安全交接", "Check and Hand Off Safely")], defaultId: 0, cancelId: 0, noLink: true });
    if (answer.response !== 1 || quitting) return;
    const state = await backend.handoff();
    backendUrl = localAddress(state.url).href;
    await window?.loadURL(backendUrl);
    await showQuitMessage({ type: "info", message: t("启动器安全交接完成", "Launcher handoff completed"),
      detail: t(`当前桌面 ${app.getVersion()} build ${release.buildNumber} 已启动原业务包 ${state.version}，支持持久化体验版通道。请在设置中检查更新。`, `Desktop ${app.getVersion()} build ${release.buildNumber} started the existing app package ${state.version} with persistent prerelease channel support. Check for updates in Settings.`), buttons: [t("好", "OK")] });
  } catch (error) { await showQuitMessage({ type: "warning", message: t("启动器交接未完成", "Launcher handoff not completed"), detail: error.message, buttons: [t("好", "OK")] }); }
  finally { handingOff = false; }
}

/** Shell-level escape route: works no matter what the installed business package does. */
async function requestUpgradeReset() {
  if (startup || quitting || askingQuit || handingOff || resetting || updater?.busy || !backend) return;
  resetting = true;
  try {
    const answer = await showQuitMessage({ type: "warning", title: t("清理升级状态", "Reset Update State"),
      message: t(`清理业务包升级状态，并用桌面内置版本 ${backend.bundled.version} 重新启动后台？`, `Reset app package update state and restart the backend with the bundled version ${backend.bundled.version}?`),
      detail: t("用于升级卡住或新版本无法启动时。会先停止本桌面启动的后台，再把升级记录（版本选择、候选包、交接与旧版升级日志）移到 pi-web/upgrade-reset 下保存，不删除任何文件。聊天、设置、插件代码和数据不受影响；之后可在设置中重新检查更新。", "Use this when an update is stuck or a new version cannot start. The backend this desktop started is stopped first, then update records (version selection, candidate, handoff and legacy update journals) are moved into pi-web/upgrade-reset; nothing is deleted. Chats, settings, plugin code and data are not affected; you can check for updates again in Settings afterwards."),
      buttons: [t("取消", "Cancel"), t("清理并恢复内置版本", "Reset and Use Bundled Version")], defaultId: 0, cancelId: 0, noLink: true });
    if (answer.response !== 1 || quitting) return;
    let result;
    try { result = await backend.resetUpgrade(); }
    catch (error) {
      if (!/停止已取消|Stop cancelled/.test(error.message)) throw error;
      const forced = await showQuitMessage({ type: "warning", message: t("插件视图尚未确认保存，后台拒绝停止。", "A plugin view has not confirmed its save, so the backend refused to stop."),
        detail: t("可以先保存并关闭绘图或编辑器后重试；或强制停止（插件中未保存的编辑可能丢失）。", "Save and close drawings or editors and retry, or force the stop (unsaved plugin edits may be lost)."),
        buttons: [t("取消", "Cancel"), t("强制停止并清理", "Force Stop and Reset")], defaultId: 0, cancelId: 0, noLink: true });
      if (forced.response !== 1 || quitting) return;
      result = await backend.resetUpgrade({ force: true });
    }
    backendUrl = localAddress(result.state.url).href;
    if (window && !window.isDestroyed()) await window.loadURL(backendUrl); else showWindow();
    await showQuitMessage({ type: "info", message: t("升级状态已清理", "Update state reset"),
      detail: result.folder ? t(`已移走 ${result.moved.length} 项记录到：${result.folder}\n当前运行内置版本 ${result.state.version}。`, `Moved ${result.moved.length} records to: ${result.folder}\nNow running the bundled version ${result.state.version}.`)
        : t(`没有需要清理的升级记录。当前运行内置版本 ${result.state.version}。`, `There were no update records to reset. Now running the bundled version ${result.state.version}.`), buttons: [t("好", "OK")] });
  } catch (error) { await showQuitMessage({ type: "warning", message: t("升级状态未清理", "Update state not reset"), detail: error.message, buttons: [t("好", "OK")] }); }
  finally { resetting = false; }
}

function installMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: appName, submenu: [
      { label: t(`关于 ${appName}`, `About ${appName}`), click: async () => {
        await backend?.refresh().catch(() => {});
        if (askingQuit || quitting) return;
        return dialog.showMessageBox({ type: "info", message: appName,
          detail: t(`桌面外壳版本 ${app.getVersion()} · 桌面构建 ${release.buildNumber}\n当前 pi-webapp ${backend?.state?.version ?? "unknown"}\n随包 Pi ${bundledPiVersion}（已有共享后台仍使用其自身版本）\n应用位置：${app.getPath("exe")}\n当前连接：${backend?.owned ? "桌面自有后台" : "已有共享后台"}\n后台启动器 ${backend?.state?.launcherVersion ?? "unknown"} · 启动桌面 ${backend?.state?.desktopShell?.version ?? "unknown"} build ${backend?.state?.desktopShell?.build ?? "unknown"}\n启动器通道持久化：${backend?.state?.desktopReleaseChannels === true ? "支持" : backend?.state?.desktopReleaseChannels === false ? "不支持" : "未报告"}\n业务包通过界面设置中的“应用更新”升级；“检查桌面更新”仅更新桌面外壳安装包。`, `Desktop shell ${app.getVersion()} · Desktop build ${release.buildNumber}\nCurrent pi-webapp ${backend?.state?.version ?? "unknown"}\nBundled Pi ${bundledPiVersion} (an existing shared backend continues to use its own version)\nApp location: ${app.getPath("exe")}\nCurrent connection: ${backend?.owned ? "desktop-owned backend" : "existing shared backend"}\nBackend launcher ${backend?.state?.launcherVersion ?? "unknown"} · Launching desktop ${backend?.state?.desktopShell?.version ?? "unknown"} build ${backend?.state?.desktopShell?.build ?? "unknown"}\nPersistent launcher channels: ${backend?.state?.desktopReleaseChannels === true ? "supported" : backend?.state?.desktopReleaseChannels === false ? "not supported" : "not reported"}\nUpdate the app package through App Updates in Settings. The Check for Desktop Updates command only updates the desktop shell installer.`) });
      } },
      { label: t("安全切换到当前桌面启动器…", "Switch to Current Desktop Launcher Safely…"), click: () => void requestLauncherHandoff() },
      { label: t("检查桌面更新…", "Check for Desktop Updates…"), click: () => { if (!startup && !handingOff) void updater?.run(); } },
      { label: t("清理升级状态并恢复内置版本…", "Reset Update State and Use Bundled Version…"), click: () => void requestUpgradeReset() },
      { label: t("取消桌面更新下载", "Cancel Desktop Update Download"), click: () => updater?.cancelDownload() },
      { type: "separator" }, { label: t("退出…", "Quit…"), accelerator: "CmdOrCtrl+Q", click: () => void requestQuit() },
    ] },
    { label: t("编辑", "Edit"), submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" },
      { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    { label: t("窗口", "Window"), submenu: [
      { label: t("显示主窗口", "Show Main Window"), click: showWindow },
      { label: t("重新加载界面", "Reload Interface"), accelerator: "CmdOrCtrl+R", click: () => window?.webContents.reload() },
      { role: "togglefullscreen" },
      { label: t("在浏览器中打开", "Open in Browser"), click: () => { if (backendUrl) void shell.openExternal(backendUrl); } },
      { label: t("打开日志目录", "Open Log Folder"), click: () => { if (backend) void shell.openPath(dirname(backend.logPath)); } },
    ] },
    { label: t("帮助", "Help"), role: "help", submenu: [
      { label: t(`${appName} 文档`, `${appName} Documentation`), click: () => void openInBrowser(docsUrl("home", t("zh", "en"))) },
      { label: t("快速开始", "Quick Start"), click: () => void openInBrowser(docsUrl("quickStart", t("zh", "en"))) },
      { label: t("故障排查", "Troubleshooting"), click: () => void openInBrowser(docsUrl("troubleshooting", t("zh", "en"))) },
      { type: "separator" },
      { label: t("在 GitHub 上反馈问题", "Report an Issue on GitHub"), click: () => void openInBrowser(issuesUrl) },
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
  setDesktopLocale(app.getLocale());
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
    getBackend: () => { if (!backend) throw new Error(t("后台身份尚未确认，请稍后重试安装", "Backend identity is not confirmed yet. Try installing again shortly.")); return backend; },
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
    dialog.showErrorBox(t(`${appName} 启动失败`, `${appName} failed to start`), `${error.code === "ENOENT" ? t("缺少桌面运行环境，请先运行 npm run desktop:prepare 或重新安装桌面应用。", "The desktop runtime is missing. Run npm run desktop:prepare or reinstall the desktop app.") : error.message}\n\n${backend ? t(`日志：${backend.logPath}`, `Logs: ${backend.logPath}`) : ""}`);
    quitting = true;
    app.exit(1);
  }
  });
}
