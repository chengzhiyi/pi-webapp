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
const installerPayload = Boolean(process.env.PI_WEB_DESKTOP_EXECUTABLE);
const executablePath = process.env.PI_WEB_DESKTOP_EXECUTABLE ?? (process.platform === "darwin" ? join(root, `desktop-release/${process.arch === "arm64" ? "mac-arm64" : "mac"}/${appName}.app/Contents/MacOS/${appName}`)
  : process.platform === "win32" ? join(root, `desktop-release/win-unpacked/${appName}.exe`)
  : join(root, `desktop-release/linux-unpacked/${appName}`));
const env = { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir,
  PI_WEB_SENTRY_ENABLED: "false", PI_WEBAPP_AUTO_OPEN: "0",
  // No npm/global Node/Pi paths: only system shells and utilities remain available.
  PATH: process.platform === "win32" ? `${process.env.SystemRoot}\\System32` : "/usr/bin:/bin" };
delete env.NODE_OPTIONS;
delete env.ELECTRON_RUN_AS_NODE;
let electron;
let browser;
let state;
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
  await stage("app-icon-and-runtime");
  const appIcon = await electron.evaluate(({ app, nativeImage }) => {
    const image = nativeImage.createFromPath(`${app.getAppPath()}/icons/icon.png`);
    return { empty: image.isEmpty(), size: image.getSize() };
  });
  assert.deepEqual(appIcon, { empty: false, size: { width: 1024, height: 1024 } });
  const runtimeRoot = packaged ? join(await electron.evaluate(() => process.resourcesPath), "runtime") : join(root, ".desktop/runtime");
  const piVersion = JSON.parse(await readFile(join(runtimeRoot, "backend/node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8")).version;
  const expectedPi = JSON.parse(await readFile(join(root, "package.json"), "utf8")).devDependencies["@earendil-works/pi-coding-agent"];
  assert.equal(piVersion, expectedPi, "actual installed/mounted payload must contain the pinned latest Pi");
  await stage("first-window-and-settings");
  const page = await electron.firstWindow({ timeout: 70000 });
  page.on("pageerror", error => errors.push(error.message));
  await page.evaluate(() => { localStorage.setItem("pi-web-locale", "en"); });
  await page.reload();
  await expect(page.getByRole("button", { name: "Close Pi settings", exact: true })).toBeVisible({ timeout: 30000 });
  await stage("native-identity");
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
  await stage("interactive-pty");
  await page.getByRole("button", { name: "Open right sidebar", exact: true }).click();
  const rightbar = page.locator("[data-sidebar-right-session]");
  await rightbar.getByRole("button", { name: "Open terminal", exact: true }).click();
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
  const update = await fetch(`${address.origin}/api/update`, { headers: authorization, signal: AbortSignal.timeout(10000) }).then(r => r.json());
  assert.equal(update.canRestart, false);
  assert.match(update.reason, /桌面应用/);
  assert.equal((await fetch(`${address.origin}/api/update/version`, { signal: AbortSignal.timeout(10000) })).status, 401);
  const files = await fetch(`${address.origin}/api/workspace/files/list`, { method: "POST", signal: AbortSignal.timeout(10000),
    headers: { ...authorization, "Content-Type": "application/json", Origin: address.origin },
    body: JSON.stringify({ sessionId, path: "" }) });
  assert.equal(files.status, 200, await files.text());
  // A genuine browser can use the exact same authenticated backend as the desktop.
  await stage("shared-browser-backend");
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
  await stage("confirmed-owned-service-shutdown");
  // Mock only the native confirmation, then exercise the real close/stop path.
  await electron.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 2, checkboxChecked: false }); });
  const exited = electron.waitForEvent("close", { timeout: 30000 });
  await page.evaluate(() => window.close());
  await exited;
  electron = null;
  await assert.rejects(readFile(join(agentDir, "pi-web", "launcher.json")), { code: "ENOENT" });
  assert.throws(() => process.kill(state.piPid, 0));
  await writeFile(join(artifacts, "smoke-result.json"), JSON.stringify({ packaged, platform: process.platform, arch: process.arch,
    version: state.version, appName, piVersion, desktopBuild: release.buildNumber, installerPayload,
    checks: [...(installerPayload ? ["installer-payload-launch"] : []), "native-name-menu-title-pi", "about-build-and-executable-location", "custom-app-icon-loads", "standalone-runtime-without-system-node-pi", "sandboxed-renderer", "native-pty", "workspace-files",
      "authenticated-backend", "desktop-update-protection", "shared-browser-backend", "confirmed-stop-reaps-pi"], errors }, null, 2) + "\n");
  console.log("Desktop smoke passed: standalone runtime, sandbox, PTY, files, shared browser, update guard and shutdown.");
} catch (error) {
  await writeFile(join(artifacts, "smoke-failure.json"), JSON.stringify({ phase, platform: process.platform, arch: process.arch, errorType: error.name }) + "\n");
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
