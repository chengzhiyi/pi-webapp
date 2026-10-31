import assert from "node:assert/strict";
import { _electron, chromium, expect } from "@playwright/test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { saveSmokeDiagnostics, seedSmokeLocale } from "./desktop-smoke-diagnostics.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const packaged = process.argv.includes("--packaged");
const release = JSON.parse(await readFile(join(root, "desktop/release.json"), "utf8"));
const appName = release.productName;
const temporary = await mkdtemp(join(tmpdir(), "pi-desktop-smoke-"));
const artifacts = join(root, "artifacts", "desktop");
await mkdir(artifacts, { recursive: true });
const agentDir = join(temporary, "agent");
const home = join(temporary, "home");
await mkdir(home);
const installerPayload = Boolean(process.env.PI_WEB_DESKTOP_EXECUTABLE);
const executablePath = process.env.PI_WEB_DESKTOP_EXECUTABLE ?? (process.platform === "darwin" ? join(root, `desktop-release/${process.arch === "arm64" ? "mac-arm64" : "mac"}/${appName}.app/Contents/MacOS/${appName}`)
  : process.platform === "win32" ? join(root, `desktop-release/win-unpacked/${appName}.exe`)
  : join(root, `desktop-release/linux-unpacked/${appName}`));
const env = { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir,
  PI_WEB_SENTRY_ENABLED: "false", PI_WEBAPP_AUTO_OPEN: "0", PI_WEBAPP_DESKTOP_UPDATE_CHECK: "manual",
  ELECTRON_ENABLE_LOGGING: "1", PI_WEBAPP_STARTUP_TRACE: "1",
  // No npm/global Node/Pi paths: only system shells and utilities remain available.
  PATH: process.platform === "win32" ? `${process.env.SystemRoot}\\System32` : "/usr/bin:/bin",
  ...(process.platform === "win32" ? {} : { SHELL: "/bin/sh" }) };
delete env.NODE_OPTIONS;
delete env.ELECTRON_RUN_AS_NODE;
let electron;
let browser;
let state;
let electronStderr = "";
const closeSettingsName = /^(Close Pi settings|关闭 Pi 设置)$/;
const errors = [];
let phase;
async function stage(name) {
  phase = name;
  console.log(`Desktop smoke phase: ${name}`);
  await writeFile(join(artifacts, "smoke-progress.json"), JSON.stringify({ phase, platform: process.platform, arch: process.arch }) + "\n");
}
async function bounded(promise, ms = 5000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Smoke cleanup timed out")), ms); })]); }
  finally { clearTimeout(timer); }
}
try {
  await stage("launch-electron");
  electron = await _electron.launch({ ...(packaged ? { executablePath } : {}),
    args: [...(packaged ? [] : [join(root, "desktop")]), `--user-data-dir=${join(temporary, "electron")}`], env, timeout: 60000 });
  electron.process().stderr?.on("data", chunk => { electronStderr = (electronStderr + chunk.toString()).slice(-131072); });
  // Seed before navigation rather than interrupting the first bootstrap with a reload.
  // Bilingual selectors also cover a window that was already loading at launch.
  await electron.context().addInitScript(seedSmokeLocale);
  await stage("app-icon-and-runtime");
  await bounded(electron.evaluate(({ app }) => {
    app.on("render-process-gone", (_event, _contents, details) => console.error("desktop-renderer-gone", JSON.stringify({ reason: details.reason, exitCode: details.exitCode })));
    app.on("child-process-gone", (_event, details) => console.error("desktop-child-gone", JSON.stringify({ type: details.type, reason: details.reason, exitCode: details.exitCode })));
  }), 10000);
  const appIcon = await electron.evaluate(({ app, nativeImage }) => {
    const image = nativeImage.createFromPath(`${app.getAppPath()}/icons/icon.png`);
    return { empty: image.isEmpty(), size: image.getSize() };
  });
  assert.deepEqual(appIcon, { empty: false, size: { width: 1024, height: 1024 } });
  const runtimeRoot = packaged ? join(await electron.evaluate(() => process.resourcesPath), "runtime") : join(root, ".desktop/runtime");
  const piVersion = JSON.parse(await readFile(join(runtimeRoot, "backend/node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8")).version;
  const expectedPi = JSON.parse(await readFile(join(root, "package.json"), "utf8")).devDependencies["@earendil-works/pi-coding-agent"];
  assert.equal(piVersion, expectedPi, "actual installed/mounted payload must contain the pinned latest Pi");
  await stage("first-window");
  const page = await electron.firstWindow({ timeout: 70000 });
  page.on("pageerror", error => errors.push(error.message));
  await stage("initial-ui-ready");
  await expect(page.getByRole("button", { name: closeSettingsName })).toBeVisible({ timeout: 45000 });
  // Still test a genuine reload, but only after first startup has become usable.
  await stage("reload-ready-ui");
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
  await expect(page.getByRole("button", { name: closeSettingsName })).toBeVisible({ timeout: 30000 });
  await stage("native-identity");
  const identity = await electron.evaluate(async ({ app, BrowserWindow, Menu, dialog }) => {
    let about;
    const show = dialog.showMessageBox;
    dialog.showMessageBox = async options => { about = options; return { response: 0 }; };
    try {
      const menu = Menu.getApplicationMenu();
      menu.items[0].submenu.items[0].click();
      for (let attempt = 0; !about && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
      return { name: app.getName(), menu: menu.items[0].label, title: BrowserWindow.getAllWindows()[0].getTitle(), about };
    } finally { dialog.showMessageBox = show; }
  });
  assert.equal(identity.name, appName);
  assert.equal(identity.menu, appName);
  assert.equal(identity.title, appName);
  assert.equal(identity.about.message, appName);
  assert.ok(identity.about.detail.includes(`桌面构建 ${release.buildNumber}`));
  assert.ok(identity.about.detail.includes("应用位置："));
  const updateMenu = await electron.evaluate(({ Menu }) => Menu.getApplicationMenu().items[0].submenu.items.map(item => item.label));
  assert.ok(updateMenu.includes("检查桌面更新…"));
  assert.ok(updateMenu.includes("取消桌面更新下载"));
  // Exercise the packaged native menu -> fixed Release metadata -> actual verified
  // download -> manual handoff path. Only network bytes/native dialogs are fixtures;
  // no installed app, publisher certificate, or user's backend is used/replaced.
  const supportsUpdateDownload = packaged && process.platform === "darwin" && process.arch === "arm64";
  if (supportsUpdateDownload) await electron.evaluate(async ({ Menu, dialog, shell, app }, build) => {
    const fs = process.getBuiltinModule("node:fs/promises");
    const { createHash } = process.getBuiltinModule("node:crypto");
    const original = { fetch: globalThis.fetch, show: dialog.showMessageBox, reveal: shell.showItemInFolder };
    const data = Buffer.from("packaged desktop update download fixture");
    const version = app.getVersion(); const nextBuild = build + 1;
    const tag = `desktop-v${version}-b${nextBuild}`;
    const name = `pi-${version}-desktop.${nextBuild}-mac-arm64.dmg`;
    const url = `https://github.com/chengzhiyi/pi-webapp/releases/download/${tag}/${name}`;
    const manifest = { schemaVersion: 1, repository: "chengzhiyi/pi-webapp", version, build: nextBuild, tag,
      productName: "pi", platform: "darwin", arch: "arm64", sourceCommit: "a".repeat(40), unsigned: true, prerelease: true,
      asset: { name, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") } };
    const remote = { tag_name: tag, prerelease: true, draft: false, assets: [{ name: "desktop-release.json" },
      { name, size: data.length, state: "uploaded", browser_download_url: url }] };
    let revealed; let complete; let timer;
    const done = new Promise((resolve, reject) => { complete = resolve; timer = setTimeout(() => reject(new Error("packaged update handoff timed out")), 15000); });
    try {
      globalThis.fetch = async value => {
        if (value.startsWith("https://api.github.com/repos/chengzhiyi/pi-webapp/releases?")) return new Response(JSON.stringify([remote]));
        if (value.endsWith("/desktop-release.json")) return new Response(JSON.stringify(manifest));
        if (value === url) return new Response(data);
        throw new Error("unexpected updater request");
      };
      shell.showItemInFolder = path => { revealed = path; };
      dialog.showMessageBox = async options => {
        if (options.title === "发现桌面更新") return { response: 1 };
        if (options.title === "桌面安装包已下载") complete();
        return { response: 0 };
      };
      Menu.getApplicationMenu().items[0].submenu.items.find(item => item.label === "检查桌面更新…").click();
      await done;
      await new Promise(resolve => setTimeout(resolve, 20));
      if (!revealed || !(await fs.readFile(revealed)).equals(data)) throw new Error("checked DMG handoff missing");
    } finally {
      clearTimeout(timer); globalThis.fetch = original.fetch; dialog.showMessageBox = original.show; shell.showItemInFolder = original.reveal;
      if (revealed) await fs.rm(process.getBuiltinModule("node:path").dirname(revealed), { recursive: true, force: true });
    }
  }, release.buildNumber);
  await page.screenshot({ path: join(artifacts, "desktop-model-setup.png") });
  await page.getByRole("button", { name: closeSettingsName }).click();
  state = JSON.parse(await readFile(join(agentDir, "pi-web", "launcher.json"), "utf8"));
  assert.equal(state.runtimeKind, "desktop");
  const prefs = await electron.evaluate(({ BrowserWindow }) => {
    const value = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { nodeIntegration: value.nodeIntegration, contextIsolation: value.contextIsolation, sandbox: value.sandbox };
  });
  assert.deepEqual(prefs, { nodeIntegration: false, contextIsolation: true, sandbox: true });
  assert.equal(await page.evaluate(() => typeof window.require), "undefined");
  await stage("interactive-pty");
  await page.getByRole("button", { name: /^(Open right sidebar|打开右侧边栏)$/ }).click();
  const rightbar = page.locator("[data-sidebar-right-session]");
  await rightbar.getByRole("button", { name: /^(Open terminal|打开终端)$/ }).click();
  const terminal = page.locator("[data-workspace-terminal]:visible");
  await expect(terminal).toHaveAttribute("data-terminal-phase", "connected", { timeout: 15000 });
  // Split the marker so echoed input cannot satisfy the output assertion.
  await terminal.locator("textarea").fill(process.platform === "win32"
    ? "echo PI_DESKTOP_TERMINAL_^O^K"
    : "printf '\\nPI_DESKTOP_%s\\n' TERMINAL_OK");
  await terminal.locator("textarea").press("Enter");
  await expect(terminal.locator(".xterm-rows")).toContainText("PI_DESKTOP_TERMINAL_OK");
  await stage("authenticated-api-and-files");
  const sessionId = await rightbar.getAttribute("data-sidebar-right-session");
  const address = new URL(state.url);
  const authorization = { Authorization: `Bearer ${address.hash.slice(1)}` };
  const update = await fetch(`${address.origin}/api/update`, { headers: authorization, signal: AbortSignal.timeout(30000) }).then(r => r.json());
  assert.equal(update.canRestart, true);
  assert.match(update.reason, /用户目录/);
  assert.equal(update.desktopShell.build, String(release.buildNumber));
  await stage("desktop-preview-channel");
  const preference = await fetch(`${address.origin}/api/update/channel`, { method: "POST", signal: AbortSignal.timeout(10000),
    headers: { ...authorization, "Content-Type": "application/json", Origin: address.origin },
    body: JSON.stringify({ sessionId, channel: "alpha" }) });
  assert.equal(preference.status, 200);
  const preview = await fetch(`${address.origin}/api/update`, { headers: authorization, signal: AbortSignal.timeout(30000) }).then(r => r.json());
  assert.equal(preview.channel, "alpha");
  assert.equal(preview.canRestart, true, "the actual installed shell must admit preview updates");
  assert.equal(preview.requiresDesktopUpgrade, undefined);
  assert.equal(JSON.parse(await readFile(join(agentDir, "pi-web", "update-preferences.json"), "utf8")).channel, "alpha");
  const blocked = await fetch(`${address.origin}/api/update`, { method: "POST", headers: { ...authorization, "Content-Type": "application/json" }, body: JSON.stringify({ sessionId }) });
  assert.equal(blocked.status, 409, "an open terminal must block package restarts");
  assert.match((await blocked.json()).error, /终端/);
  assert.equal((await fetch(`${address.origin}/api/update/version`, { signal: AbortSignal.timeout(10000) })).status, 401);
  const files = await fetch(`${address.origin}/api/workspace/files/list`, { method: "POST", signal: AbortSignal.timeout(10000),
    headers: { ...authorization, "Content-Type": "application/json", Origin: address.origin },
    body: JSON.stringify({ sessionId, path: "" }) });
  assert.equal(files.status, 200, await files.text());
  // A genuine browser can use the exact same authenticated backend as the desktop.
  await stage("shared-browser-backend");
  browser = await chromium.launch({ headless: true, ...(process.env.PI_WEB_TEST_CHROME === "true" ? { channel: "chrome" } : {}) });
  const web = await browser.newPage();
  await web.addInitScript(seedSmokeLocale);
  await web.goto(state.url);
  await expect(web.getByRole("button", { name: "Close Pi settings", exact: true })).toBeVisible();
  await web.getByRole("button", { name: "Close Pi settings", exact: true }).click();
  await expect(web.locator("[data-sidebar-right-session]")).toHaveAttribute("data-sidebar-right-session", sessionId);
  assert.equal(JSON.parse(await readFile(join(agentDir, "pi-web", "launcher.json"), "utf8")).pid, state.pid);
  await page.screenshot({ path: join(artifacts, "desktop-terminal.png") });
  assert.deepEqual(errors, []);
  await stage("quit-cancel-and-refused-stop-recovery");
  // Only the stop failure and native answers are fixtures. Drive the actual
  // application menu repeatedly to catch a stuck askingQuit gate after recovery.
  const quitRecovery = await electron.evaluate(async ({ app, Menu, dialog, BrowserWindow }) => {
    const { DesktopBackend } = process.getBuiltinModule("node:module").createRequire(`${app.getAppPath()}/package.json`)("./backend.mjs");
    const original = { stop: DesktopBackend.prototype.stop, refresh: DesktopBackend.prototype.refresh, show: dialog.showMessageBox };
    const answers = [0, 2, 0, 0];
    const prompts = [];
    const parents = [];
    const item = Menu.getApplicationMenu().items[0].submenu.items.find(item => item.label === "退出…");
    const waitForPrompts = async count => {
      for (let n = 0; n < 200 && prompts.length < count; n++) await new Promise(resolve => setTimeout(resolve, 10));
      if (prompts.length !== count) throw new Error("quit flow did not reach its expected confirmation");
      await new Promise(resolve => setImmediate(resolve));
    };
    try {
      // A desktop-only confirmation must remain reachable with an unhealthy service.
      DesktopBackend.prototype.refresh = async () => { throw new Error("fixture backend health failure"); };
      DesktopBackend.prototype.stop = async () => { throw new Error("停止已取消：插件保存或释放未完成"); };
      dialog.showMessageBox = async (...args) => {
        parents.push(args.length === 2 && args[0] === BrowserWindow.getAllWindows()[0]);
        prompts.push(args.at(-1)); return { response: answers.shift() };
      };
      item.click(); await waitForPrompts(1); // Cancel.
      item.click(); await waitForPrompts(3); // Stop refused, return to app.
      item.click(); await waitForPrompts(4); // Retry remains possible.
      return { prompts, parents, windows: BrowserWindow.getAllWindows().length };
    } finally {
      DesktopBackend.prototype.stop = original.stop; DesktopBackend.prototype.refresh = original.refresh;
      dialog.showMessageBox = original.show;
    }
  });
  assert.equal(quitRecovery.windows, 1);
  assert.deepEqual(quitRecovery.parents, [true, true, true, true]);
  assert.equal(quitRecovery.prompts[2].title, "后台尚未停止");
  assert.match(quitRecovery.prompts[2].detail, /插件保存或释放未完成/);
  assert.equal(JSON.parse(await readFile(join(agentDir, "pi-web", "launcher.json"), "utf8")).pid, state.pid);
  await stage("confirmed-owned-service-shutdown");
  // Mock only the native confirmation, then exercise the real close/stop path.
  await electron.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 2, checkboxChecked: false }); });
  const exited = electron.waitForEvent("close", { timeout: 30000 });
  await page.evaluate(() => window.close());
  await exited;
  electron = null;
  await assert.rejects(readFile(join(agentDir, "pi-web", "launcher.json")), { code: "ENOENT" });
  assert.throws(() => process.kill(state.piPid, 0));
  await stage("desktop-only-exit-preserves-service");
  const shutdownErrorsPath = join(temporary, "shutdown-errors.jsonl");
  // Relaunch an owned service, leave it alive, then attach and quit again. Only
  // native confirmations are automated; verify the real processes and HTTP API.
  for (const mode of ["stop", "keep", "attach"]) {
    electron = await _electron.launch({ ...(packaged ? { executablePath } : {}),
      args: [...(packaged ? [] : [join(root, "desktop")]), `--user-data-dir=${join(temporary, "electron")}`], env, timeout: 60000 });
    await electron.firstWindow({ timeout: 70000 });
    const shared = JSON.parse(await readFile(join(agentDir, "pi-web", "launcher.json"), "utf8"));
    await electron.evaluate(({ app, dialog }, { errorsPath, mode }) => {
      const { DesktopBackend } = process.getBuiltinModule("node:module").createRequire(`${app.getAppPath()}/package.json`)("./backend.mjs");
      dialog.showErrorBox = title => process.getBuiltinModule("node:fs").appendFileSync(errorsPath, JSON.stringify(title) + "\n");
      if (mode !== "stop") DesktopBackend.prototype.refresh = async () => { throw new Error("fixture backend health failure"); };
      dialog.showMessageBox = async () => ({ response: mode === "stop" ? 2 : 1 });
    }, { errorsPath: shutdownErrorsPath, mode });
    const desktopClosed = electron.waitForEvent("close", { timeout: 15000 });
    await electron.evaluate(({ Menu }) => {
      setImmediate(() => Menu.getApplicationMenu().items[0].submenu.items.find(item => item.label === "退出…").click());
    });
    await desktopClosed;
    electron = null;
    assert.equal(await readFile(shutdownErrorsPath, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; }), "",
      "closing a loading window must not show a blocking native error box");
    if (mode === "stop") {
      await assert.rejects(readFile(join(agentDir, "pi-web", "launcher.json")), { code: "ENOENT" });
      assert.throws(() => process.kill(shared.piPid, 0));
      continue;
    }
    assert.equal(JSON.parse(await readFile(join(agentDir, "pi-web", "launcher.json"), "utf8")).pid, shared.pid);
    process.kill(shared.pid, 0); process.kill(shared.piPid, 0);
    const sharedUrl = new URL(shared.url);
    assert.equal((await fetch(`${sharedUrl.origin}/api/update/version`, { signal: AbortSignal.timeout(5000),
      headers: { Authorization: `Bearer ${sharedUrl.hash.slice(1)}` } })).status, 200);
    if (mode === "attach") await stage("attached-exit-preserves-service");
  }
  await writeFile(join(artifacts, "smoke-result.json"), JSON.stringify({ packaged, platform: process.platform, arch: process.arch,
    version: state.version, appName, piVersion, desktopBuild: release.buildNumber, installerPayload,
    checks: [...(installerPayload ? ["installer-payload-launch"] : []), "native-desktop-update-menu",
      ...(supportsUpdateDownload ? ["native-desktop-update-download"] : []),
      "native-name-menu-title-pi", "about-build-and-executable-location", "custom-app-icon-loads", "standalone-runtime-without-system-node-pi", "sandboxed-renderer", "native-pty", "workspace-files",
      "authenticated-backend", "desktop-update-protection", "desktop-package-update-enabled", "desktop-release-channel-enabled", "shared-browser-backend", "quit-cancel-refusal-and-retry", "confirmed-stop-reaps-pi", "desktop-only-exit-preserves-service", "attached-exit-preserves-service"], errors }, null, 2) + "\n");
  console.log("Desktop smoke passed: standalone runtime, sandbox, PTY, files, shared browser, update guard and shutdown.");
} catch (error) {
  await writeFile(join(artifacts, "smoke-failure.json"), JSON.stringify({ phase, platform: process.platform, arch: process.arch, errorType: error.name }) + "\n");
  await saveSmokeDiagnostics({ artifacts, agentDir, phase, error, stderr: electronStderr, env })
    .catch(() => console.error("Could not save isolated smoke diagnostics"));
  const failedPage = electron?.windows()[0];
  if (failedPage) await bounded(failedPage.screenshot({ path: join(artifacts, "desktop-failure.png"), timeout: 4000 })).catch(() => {});
  throw error;
} finally {
  await bounded(browser?.close()).catch(() => {});
  if (electron) {
    const ownedChild = electron.process();
    await bounded(electron.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 2, checkboxChecked: false }); })).catch(() => {});
    await bounded(electron.close()).catch(() => { try { ownedChild.kill("SIGKILL"); } catch {} });
  }
  // Clean up only this test's isolated service, even when startup/UI assertions fail.
  try {
    const current = JSON.parse(await readFile(join(agentDir, "pi-web", "launcher.json"), "utf8"));
    await writeFile(join(agentDir, "pi-web", "launcher.stop"), current.nonce);
    for (let attempt = 0; attempt < 150; attempt++) {
      try { process.kill(current.pid, 0); } catch { break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } catch { /* Already stopped. */ }
  await rm(temporary, { recursive: true, force: true });
}
