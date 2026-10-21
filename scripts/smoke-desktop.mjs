import assert from "node:assert/strict";
import { _electron, chromium, expect } from "@playwright/test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
const executablePath = process.platform === "darwin" ? join(root, `desktop-release/${process.arch === "arm64" ? "mac-arm64" : "mac"}/${appName}.app/Contents/MacOS/${appName}`)
  : process.platform === "win32" ? join(root, `desktop-release/win-unpacked/${appName}.exe`)
  : join(root, `desktop-release/linux-unpacked/${appName}`);
const env = { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir,
  PI_WEB_SENTRY_ENABLED: "false", PI_WEBAPP_AUTO_OPEN: "0", PI_WEBAPP_DESKTOP_UPDATE_CHECK: "manual",
  // No npm/global Node/Pi paths: only system shells and utilities remain available.
  PATH: process.platform === "win32" ? `${process.env.SystemRoot}\\System32` : "/usr/bin:/bin" };
delete env.NODE_OPTIONS;
delete env.ELECTRON_RUN_AS_NODE;
let electron;
let browser;
let state;
const errors = [];
try {
  electron = await _electron.launch({ ...(packaged ? { executablePath } : {}),
    args: [...(packaged ? [] : [join(root, "desktop")]), `--user-data-dir=${join(temporary, "electron")}`], env, timeout: 60000 });
  const appIcon = await electron.evaluate(({ app, nativeImage }) => {
    const image = nativeImage.createFromPath(`${app.getAppPath()}/icons/icon.png`);
    return { empty: image.isEmpty(), size: image.getSize() };
  });
  assert.deepEqual(appIcon, { empty: false, size: { width: 1024, height: 1024 } });
  const page = await electron.firstWindow({ timeout: 70000 });
  page.on("pageerror", error => errors.push(error.message));
  await page.evaluate(() => { localStorage.setItem("pi-web-locale", "en"); });
  await page.reload();
  await expect(page.getByRole("button", { name: "Close Pi settings", exact: true })).toBeVisible({ timeout: 30000 });
  const identity = await electron.evaluate(async ({ app, BrowserWindow, Menu, dialog }) => {
    let about;
    const show = dialog.showMessageBox;
    dialog.showMessageBox = async options => { about = options; return { response: 0 }; };
    try {
      const menu = Menu.getApplicationMenu();
      await menu.items[0].submenu.items[0].click();
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
  await electron.evaluate(async ({ Menu, dialog, shell, app }, build) => {
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
  await page.getByRole("button", { name: "Close Pi settings", exact: true }).click();
  state = JSON.parse(await readFile(join(agentDir, "pi-web", "launcher.json"), "utf8"));
  assert.equal(state.runtimeKind, "desktop");
  const prefs = await electron.evaluate(({ BrowserWindow }) => {
    const value = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { nodeIntegration: value.nodeIntegration, contextIsolation: value.contextIsolation, sandbox: value.sandbox };
  });
  assert.deepEqual(prefs, { nodeIntegration: false, contextIsolation: true, sandbox: true });
  assert.equal(await page.evaluate(() => typeof window.require), "undefined");
  await page.getByRole("button", { name: "Open right sidebar", exact: true }).click();
  const rightbar = page.locator("[data-sidebar-right-session]");
  await rightbar.getByRole("button", { name: "Open terminal", exact: true }).click();
  const terminal = page.locator("[data-workspace-terminal]:visible");
  await expect(terminal).toHaveAttribute("data-terminal-phase", "connected", { timeout: 15000 });
  await terminal.locator("textarea").fill("printf '\\nPI_DESKTOP_TERMINAL_OK\\n'");
  await terminal.locator("textarea").press("Enter");
  await expect(terminal.locator(".xterm-rows")).toContainText("PI_DESKTOP_TERMINAL_OK");
  const sessionId = await rightbar.getAttribute("data-sidebar-right-session");
  const address = new URL(state.url);
  const authorization = { Authorization: `Bearer ${address.hash.slice(1)}` };
  const update = await fetch(`${address.origin}/api/update`, { headers: authorization }).then(r => r.json());
  assert.equal(update.canRestart, false);
  assert.match(update.reason, /桌面应用/);
  assert.equal((await fetch(`${address.origin}/api/update/version`)).status, 401);
  const files = await fetch(`${address.origin}/api/workspace/files/list`, { method: "POST",
    headers: { ...authorization, "Content-Type": "application/json", Origin: address.origin },
    body: JSON.stringify({ sessionId, path: "" }) });
  assert.equal(files.status, 200, await files.text());
  // A genuine browser can use the exact same authenticated backend as the desktop.
  browser = await chromium.launch({ headless: true, ...(process.env.PI_WEB_TEST_CHROME === "true" ? { channel: "chrome" } : {}) });
  const web = await browser.newPage();
  await web.addInitScript(() => localStorage.setItem("pi-web-locale", "en"));
  await web.goto(state.url);
  await expect(web.getByRole("button", { name: "Close Pi settings", exact: true })).toBeVisible();
  await web.getByRole("button", { name: "Close Pi settings", exact: true }).click();
  await expect(web.locator("[data-sidebar-right-session]")).toHaveAttribute("data-sidebar-right-session", sessionId);
  assert.equal(JSON.parse(await readFile(join(agentDir, "pi-web", "launcher.json"), "utf8")).pid, state.pid);
  await page.screenshot({ path: join(artifacts, "desktop-terminal.png") });
  assert.deepEqual(errors, []);
  // Mock only the native confirmation, then exercise the real close/stop path.
  await electron.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 2, checkboxChecked: false }); });
  const exited = electron.waitForEvent("close");
  await page.evaluate(() => window.close());
  await exited;
  electron = null;
  await assert.rejects(readFile(join(agentDir, "pi-web", "launcher.json")), { code: "ENOENT" });
  assert.throws(() => process.kill(state.piPid, 0));
  await writeFile(join(artifacts, "smoke-result.json"), JSON.stringify({ packaged, platform: process.platform, arch: process.arch,
    version: state.version, appName, desktopBuild: release.buildNumber, checks: ["native-name-menu-title-pi", "about-build-and-executable-location", "native-desktop-update-menu", "native-desktop-update-download", "custom-app-icon-loads", "standalone-runtime-without-system-node-pi", "sandboxed-renderer", "native-pty", "workspace-files",
      "authenticated-backend", "desktop-update-protection", "shared-browser-backend", "confirmed-stop-reaps-pi"], errors }, null, 2) + "\n");
  console.log("Desktop smoke passed: standalone runtime, sandbox, PTY, files, shared browser, update guard and shutdown.");
} finally {
  await browser?.close();
  if (electron) {
    await electron.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 2, checkboxChecked: false }); }).catch(() => {});
    await electron.close().catch(() => {});
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
