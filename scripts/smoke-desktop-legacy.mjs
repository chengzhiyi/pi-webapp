// Run against an unchanged, already installed legacy npm release in an isolated HOME.
// Usage: npm run desktop:smoke:legacy -- --packaged --legacy-package /path/to/pi-webapp
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { openSync, closeSync } from "node:fs";
import { chmod, cp, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron, chromium, expect } from "@playwright/test";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const packageIndex = args.indexOf("--legacy-package");
if (packageIndex < 0 || !args[packageIndex + 1]) throw new Error("Pass --legacy-package pointing to an unchanged installed pi-webapp 0.1.19 release.");
const legacyRoot = resolve(args[packageIndex + 1]);
const legacyPackage = JSON.parse(await readFile(join(legacyRoot, "package.json"), "utf8"));
assert.equal(legacyPackage.name, "pi-webapp");
assert.equal(legacyPackage.version, "0.1.19");
const sourceLauncher = await readFile(join(legacyRoot, "bin/pi-webapp.mjs"));
assert.ok(!sourceLauncher.toString().includes("bridgeVersion"), "use a genuine pre-desktop release, not edited state from a new launcher");
const packaged = args.includes("--packaged");
const release = JSON.parse(await readFile(join(root, "desktop/release.json"), "utf8"));
const appName = release.productName;
const executablePath = process.platform === "darwin" ? join(root, `desktop-release/${process.arch === "arm64" ? "mac-arm64" : "mac"}/${appName}.app/Contents/MacOS/${appName}`)
  : process.platform === "win32" ? join(root, `desktop-release/win-unpacked/${appName}.exe`)
  : join(root, `desktop-release/linux-unpacked/${appName}`);
const temporary = await mkdtemp(join(tmpdir(), "pi-desktop-legacy-smoke-"));
const home = join(temporary, "home");
const agentDir = join(temporary, "agent");
const artifacts = join(root, "artifacts/desktop");
await mkdir(home);
await mkdir(artifacts, { recursive: true });
// Isolate the old package and its PTY helper. npm's --ignore-scripts updater can
// leave node-pty's published macOS helper non-executable; prepare only this copy,
// equivalent to normal installation, without changing the live release.
const fixtureModules = join(temporary, "legacy/node_modules");
const fixturePackage = join(fixtureModules, "pi-webapp");
await cp(legacyRoot, fixturePackage, { recursive: true });
await cp(join(dirname(legacyRoot), "node-pty"), join(fixtureModules, "node-pty"), { recursive: true });
for (const entry of await readdir(dirname(legacyRoot), { withFileTypes: true })) {
  if (["pi-webapp", "node-pty"].includes(entry.name)) continue;
  await symlink(join(dirname(legacyRoot), entry.name), join(fixtureModules, entry.name), entry.isDirectory() ? "junction" : "file");
}
if (process.platform === "darwin") {
  const helper = join(fixtureModules, "node-pty/prebuilds", `darwin-${process.arch}`, "spawn-helper");
  await chmod(helper, (await stat(helper)).mode | 0o111);
}
const legacyLauncher = join(fixturePackage, "bin/pi-webapp.mjs");
assert.deepEqual(await readFile(legacyLauncher), sourceLauncher);
assert.deepEqual(await readFile(join(fixturePackage, "dist/extension.js")), await readFile(join(legacyRoot, "dist/extension.js")));
const runtime = join(root, ".desktop/runtime");
const node = join(runtime, "node", process.platform === "win32" ? "node.exe" : "bin/node");
const piCli = join(runtime, "backend/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const piShim = join(temporary, process.platform === "win32" ? "pi.cmd" : "pi");
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
await writeFile(piShim, process.platform === "win32" ? `@echo off\r\n"${node}" "${piCli}" %*\r\n`
  : `#!/bin/sh\nexec ${quote(node)} ${quote(piCli)} "$@"\n`);
await chmod(piShim, 0o755);
const env = { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir,
  PI_WEB_SENTRY_ENABLED: "false", PI_WEBAPP_AUTO_OPEN: "0",
  PATH: process.platform === "win32" ? `${process.env.SystemRoot}\\System32` : "/usr/bin:/bin" };
for (const key of ["NODE_OPTIONS", "NODE_PATH", "ELECTRON_RUN_AS_NODE", "PI_WEBAPP_RUNTIME", "PI_WEBAPP_PI_CLI",
  "PI_WEBAPP_LAUNCHER_NONCE", "PI_WEBAPP_PLUGIN_DEV_ROOTS", "PI_WEBAPP_RESTART_TOKEN", "PI_WEBAPP_RESTART_PORT"]) delete env[key];
const statePath = join(agentDir, "pi-web/launcher.json");
let supervisor;
let state;
let browser;
let electron;
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
try {
  const fd = openSync(join(temporary, "legacy-start.log"), "a", 0o600);
  try { supervisor = spawn(node, [legacyLauncher, "__serve", piShim], { cwd: home, env, stdio: ["ignore", fd, fd, "ipc"] }); }
  finally { closeSync(fd); }
  await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => finish(new Error("Legacy fixture startup timed out")), 70000);
    const onMessage = message => finish(message?.type === "ready" ? null : new Error("Legacy fixture did not become ready"));
    const onExit = () => finish(new Error("Legacy fixture exited before ready"));
    const onError = () => finish(new Error("Legacy fixture could not start"));
    function finish(error) {
      clearTimeout(timer); supervisor.off("message", onMessage); supervisor.off("exit", onExit); supervisor.off("error", onError);
      error ? reject(error) : resolveReady();
    }
    supervisor.once("message", onMessage); supervisor.once("exit", onExit); supervisor.once("error", onError);
  });
  supervisor.disconnect();
  const originalState = await readFile(statePath, "utf8");
  state = JSON.parse(originalState);
  assert.equal(state.version, undefined);
  assert.equal(state.bridgeVersion, undefined);
  browser = await chromium.launch({ headless: true, ...(process.env.PI_WEB_TEST_CHROME === "true" ? { channel: "chrome" } : {}) });
  const web = await browser.newPage();
  await web.addInitScript(() => localStorage.setItem("pi-web-locale", "en"));
  await web.goto(state.url);
  await web.getByRole("button", { name: "Close Pi settings", exact: true }).click();
  await web.getByRole("button", { name: "Open right sidebar", exact: true }).click();
  const rightbar = web.locator("[data-sidebar-right-session]");
  const sessionId = await rightbar.getAttribute("data-sidebar-right-session");
  await rightbar.getByRole("button", { name: "Open terminal", exact: true }).click();
  const terminal = web.locator("[data-workspace-terminal]:visible");
  await expect(terminal).toHaveAttribute("data-terminal-phase", "connected", { timeout: 15000 });
  const send = async text => {
    await terminal.locator("textarea").fill(`printf '\\n${text}\\n'`);
    await terminal.locator("textarea").press("Enter");
    await expect(terminal.locator(".xterm-rows")).toContainText(text);
  };
  await send("LEGACY_BEFORE_DESKTOP");
  electron = await _electron.launch({ ...(packaged ? { executablePath } : {}),
    args: [...(packaged ? [] : [join(root, "desktop")]), `--user-data-dir=${join(temporary, "electron")}`], env, timeout: 60000 });
  const page = await electron.firstWindow({ timeout: 70000 });
  await page.evaluate(() => localStorage.setItem("pi-web-locale", "en"));
  await page.reload();
  await page.getByRole("button", { name: "Close Pi settings", exact: true }).click();
  await page.getByRole("button", { name: "Open right sidebar", exact: true }).click();
  await expect(page.locator("[data-sidebar-right-session]")).toHaveAttribute("data-sidebar-right-session", sessionId);
  assert.equal(await readFile(statePath, "utf8"), originalState, "desktop must not rewrite legacy state or start another service");
  await send("LEGACY_DURING_DESKTOP");
  await page.screenshot({ path: join(artifacts, "legacy-desktop-shared-service.png") });
  // An attached desktop's close action must never stop the external supervisor/Pi/PTY.
  await electron.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
  const closed = electron.waitForEvent("close");
  await page.evaluate(() => window.close());
  await closed;
  electron = null;
  assert.equal(alive(state.pid), true);
  assert.equal(alive(state.piPid), true);
  assert.equal(await readFile(statePath, "utf8"), originalState);
  await assert.rejects(readFile(join(agentDir, "pi-web/launcher.stop")), { code: "ENOENT" });
  await send("LEGACY_AFTER_DESKTOP_CLOSED");
  const result = { packaged, platform: process.platform, arch: process.arch, legacyVersion: legacyPackage.version,
    legacyLauncherSha256: createHash("sha256").update(sourceLauncher).digest("hex"),
    appName, desktopBuild: release.buildNumber,
    fixturePreparation: "isolated copy, unchanged launcher/extension; macOS PTY helper executable bit prepared only in fixture",
    checks: ["genuine-unmodified-legacy-launcher", "missing-metadata-reproduced", "browser-started-first", "existing-pty-before-desktop",
      "desktop-attaches-same-session", "launcher-state-byte-identical", "no-duplicate-supervisor", "existing-pty-during-desktop",
      "desktop-close-keeps-supervisor-and-pi-alive", "no-stop-file-written", "existing-browser-pty-after-desktop-close"], errors: [] };
  await writeFile(join(artifacts, "legacy-smoke-result.json"), JSON.stringify(result, null, 2) + "\n");
  console.log("Legacy smoke passed: genuine old Web backend, desktop/browser share session, existing PTY survives attach and desktop close.");
} finally {
  if (electron) {
    await electron.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); }).catch(() => {});
    await electron.close().catch(() => {});
  }
  await browser?.close();
  // Only the fixture we just created is stopped. Never read/write the real user's state.
  try {
    const current = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(current.pid, supervisor.pid);
    await writeFile(join(agentDir, "pi-web/launcher.stop"), current.nonce, { mode: 0o600 });
    for (let attempt = 0; attempt < 150 && alive(current.pid); attempt++) await new Promise(resolveWait => setTimeout(resolveWait, 100));
    assert.equal(alive(current.pid), false, "isolated legacy supervisor must be reaped");
    assert.equal(alive(current.piPid), false, "isolated legacy Pi must be reaped");
  } finally {
    if (supervisor && supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill("SIGTERM");
    await rm(temporary, { recursive: true, force: true });
  }
}
