// Local packaged-shell acceptance. Exact tgz is pre-staged with the real installer;
// no registry/provider requests, production fetch monkeypatches or app payload edits.
import assert from "node:assert/strict";
import { _electron, expect } from "@playwright/test";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { HostedPluginInstaller } from "../src/host/server/plugins/hosted/installer.ts";

assert.ok(process.env.HOSTED_EXCALIDRAW_TGZ, "Supply an exact local plugin archive");
assert.ok(process.env.PI_WEB_DESKTOP_EXECUTABLE, "Supply the exact locally packaged executable");
const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = await realpath(await mkdtemp(join(tmpdir(), "pi-hosted-packaged-")));
const artifacts = join(root, "artifacts/hosted-desktop"); await mkdir(artifacts, { recursive: true });
const agentDir = join(temporary, "agent"), home = join(temporary, "home"), hostedRoot = join(agentDir, "pi-web/hosted"); await mkdir(home);
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const bytes = await readFile(process.env.HOSTED_EXCALIDRAW_TGZ);
const installer = new HostedPluginInstaller({ root: join(hostedRoot, "packages"), hostVersion: pkg.version, fetch: async () => { throw new Error("No registry in packaged smoke"); } });
await installer.installArchive("@chengzhiyi/pi-excalidraw", bytes, "sha512-" + createHash("sha512").update(bytes).digest("base64"), "0.1.0");
// Deliberately suppress startup update discovery for this fixed-host offline fixture.
await writeFile(join(hostedRoot, "host-version.json"), JSON.stringify({ version: pkg.version }));
const env = { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir,
  PI_WEB_SENTRY_ENABLED: "false", PI_WEBAPP_AUTO_OPEN: "0", PI_WEBAPP_DESKTOP_UPDATE_CHECK: "manual",
  PATH: process.platform === "win32" ? `${process.env.SystemRoot}\\System32` : "/usr/bin:/bin" };
for (const key of ["NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "PI_WEBAPP_PLUGIN_DEV_ROOTS"]) delete env[key];
let electron, state, page;
const errors = [], external = [], readyViews = new Map(); let phase = "launch";
const stage = value => { phase = value; console.log("Hosted desktop phase:", value); };
try {
  electron = await _electron.launch({ executablePath: process.env.PI_WEB_DESKTOP_EXECUTABLE, args: [`--user-data-dir=${join(temporary, "electron")}`], env, timeout: 60_000 });
  await electron.context().addInitScript(() => {
    // Electron also applies context init scripts to transient about:blank frames.
    // Do not turn that origin-less test setup into spurious application page errors.
    if (location.protocol !== "http:") return;
    localStorage.setItem("pi-web-locale", "en"); localStorage.setItem("pi-web-theme", "light"); Reflect.deleteProperty(window, "showSaveFilePicker");
  });
  page = await electron.firstWindow({ timeout: 70_000 }); page.setDefaultTimeout(15_000);
  page.on("pageerror", error => errors.push(error.message));
  page.on("response", response => {
    if (new URL(response.url()).pathname !== "/api/hosted-plugins/views" || response.request().method() !== "POST") return;
    const input = response.request().postDataJSON();
    if (input.operation === "change" && response.status() === 200) {
      if (!input.busy) readyViews.set(input.mountId, input.generation); else readyViews.delete(input.mountId);
    }
  });
  await expect(page.getByRole("button", { name: /^(Close Pi settings|关闭 Pi 设置)$/ })).toBeVisible({ timeout: 45_000 });
  await page.getByRole("button", { name: /^(Close Pi settings|关闭 Pi 设置)$/ }).click();
  state = JSON.parse(await readFile(join(agentDir, "pi-web/launcher.json"), "utf8"));
  const address = new URL(state.url), headers = { Authorization: "Bearer " + address.hash.slice(1), Origin: address.origin, "Content-Type": "application/json" };
  page.on("request", request => { if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== address.origin) external.push(request.url()); });
  const request = async (path, input) => {
    const response = await fetch(address.origin + path, { headers, ...(input ? { method: "POST", body: JSON.stringify(input) } : {}) });
    assert.equal(response.status, 200, "Packaged authenticated request rejected: " + path); return response.json();
  };
  const session = await request("/api/session");
  assert.equal(await realpath(session.cwd), home, "Never write outside the isolated HOME");
  const id = "@chengzhiyi/pi-excalidraw", sessionId = session.sessionId;
  const catalog = async () => (await request("/api/hosted-plugins")).plugins[0];
  const action = async (action, input) => request("/api/hosted-plugins/action", { pluginId: id, generation: (await catalog()).generation, sessionId, action, input });
  const bootId = await page.evaluate(() => { const value = crypto.randomUUID(); window.__packagedHostedBoot = value; return value; });
  const electronPid = electron.process().pid;
  const manager = page.locator("[data-hosted-management]");
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  await expect(manager).toContainText("Installed · Disabled");
  stage("enable-real-packaged-worker");
  await manager.getByRole("button", { name: "Enable", exact: true }).click();
  await expect(manager).toContainText("Installed · Enabled");
  // Management deliberately hides the live workbench; return through real session navigation.
  await page.getByRole("button", { name: /^(当前会话|Current session)$/, exact: true }).click();
  const expand = page.getByRole("button", { name: "Open right sidebar", exact: true });
  await expect(expand).toBeVisible(); await expand.click();
  await page.getByRole("button", { name: "Excalidraw", exact: true }).click();
  const frame = page.frameLocator('iframe[title="Excalidraw workspace"]');
  const canvas = frame.locator(".excalidraw canvas.interactive"); await expect(canvas).toBeVisible();
  stage("native-draw-keyboard-and-chinese");
  await canvas.click(); await page.keyboard.press("r");
  const box = await canvas.boundingBox(); assert.ok(box);
  await page.mouse.move(box.x + 200, box.y + 200); await page.mouse.down(); await page.mouse.move(box.x + 400, box.y + 320); await page.mouse.up();
  await expect.poll(async () => (await action("list", {})).length).toBe(1);
  const draftId = (await action("list", {}))[0].id;
  await expect.poll(async () => (await action("get", { id: draftId })).scene.elements.length).toBe(1);
  const drawnX = (await action("get", { id: draftId })).scene.elements[0].x;
  await page.keyboard.press("v"); await page.keyboard.press("ControlOrMeta+a"); await page.keyboard.press("ArrowRight"); await page.keyboard.press("Escape");
  await expect.poll(async () => (await action("get", { id: draftId })).scene.elements[0].x).not.toBe(drawnX);
  const moved = (await action("get", { id: draftId })).scene.elements[0].x;
  await page.keyboard.press("ControlOrMeta+z"); await expect.poll(async () => (await action("get", { id: draftId })).scene.elements[0].x).toBe(drawnX);
  await page.keyboard.press("ControlOrMeta+Shift+z"); await expect.poll(async () => (await action("get", { id: draftId })).scene.elements[0].x).toBe(moved);
  await canvas.click(); await page.keyboard.press("t"); await page.mouse.click(box.x + 220, box.y + 400); await page.keyboard.insertText("中文桌面热插拔"); await page.keyboard.press("Escape");
  await expect.poll(async () => (await action("get", { id: draftId })).scene.elements.some(element => element.text === "中文桌面热插拔")).toBe(true);
  stage("native-save-png-and-focus");
  await canvas.click(); await page.keyboard.press("ControlOrMeta+s");
  const save = frame.getByRole("dialog", { name: "Save diagram", exact: true });
  await save.getByRole("textbox", { name: "Workspace path", exact: true }).fill("diagrams/中文桌面.excalidraw");
  await save.getByRole("button", { name: "Save", exact: true }).click(); await expect(save).toHaveCount(0);
  const saved = await readFile(join(home, "diagrams/中文桌面.excalidraw"));
  await frame.getByTestId("main-menu-trigger").click(); await frame.getByText("Export image...", { exact: true }).click();
  const exportDialog = frame.getByRole("dialog");
  const pngPath = join(artifacts, "packaged-chinese.png");
  // Fixture only the user's native save destination. Production trust/MIME/blob guards
  // still run first; a denied download never creates this file or reports completion.
  await electron.evaluate(({ session }, path) => {
    globalThis.__hostedDownload = null;
    session.defaultSession.once("will-download", (event, item) => {
      if (event.defaultPrevented) { globalThis.__hostedDownload = "denied"; return; }
      item.setSavePath(path);
      item.once("done", (_event, state) => { globalThis.__hostedDownload = state; });
    });
  }, pngPath);
  await exportDialog.getByRole("button", { name: "Export to PNG", exact: true }).click();
  await expect.poll(() => electron.evaluate(() => globalThis.__hostedDownload), { timeout: 15_000 }).toBe("completed");
  assert.deepEqual([...(await readFile(pngPath)).subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  await exportDialog.getByRole("button", { name: "Close", exact: true }).click();
  const before = await action("get", { id: draftId }), generation = (await catalog()).generation;
  stage("same-version-generation-reopen-and-disable");
  await request("/api/hosted-plugins/manage", { pluginId: id, operation: "enable", reopenEditors: true });
  await expect.poll(async () => (await catalog()).generation).toBe(generation + 1);
  await expect(canvas).toBeVisible(); await expect.poll(async () => (await action("get", { id: draftId })).scene).toEqual(before.scene);
  // Wait for the new realm's real HTTP status acknowledgement, not just painted canvas.
  await expect.poll(async () => {
    const mounts = await page.locator('iframe[title^="Excalidraw "]').evaluateAll(frames => frames.map(frame => ({ mountId: new URL(frame.src).searchParams.get("mountId"), generation: Number(new URL(frame.src).searchParams.get("generation")) })));
    return mounts.length === 2 && mounts.every(mount => mount.generation === generation + 1 && readyViews.get(mount.mountId) === mount.generation);
  }, { timeout: 15_000 }).toBe(true);
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  page.once("dialog", dialog => dialog.accept()); await manager.getByRole("button", { name: "Disable", exact: true }).click();
  await expect(manager).toContainText("Installed · Disabled"); await expect(page.locator('iframe[title^="Excalidraw "]')).toHaveCount(0);
  assert.deepEqual(await readFile(join(home, "diagrams/中文桌面.excalidraw")), saved);
  await manager.getByRole("button", { name: "Enable", exact: true }).click(); await expect(manager).toContainText("Installed · Enabled");
  assert.deepEqual((await action("get", { id: draftId })).scene, before.scene);
  assert.equal(await page.evaluate(() => window.__packagedHostedBoot), bootId);
  const finalState = JSON.parse(await readFile(join(agentDir, "pi-web/launcher.json"), "utf8"));
  assert.equal(finalState.pid, state.pid); assert.equal(finalState.piPid, state.piPid); assert.equal(electron.process().pid, electronPid);
  assert.equal((await request("/api/session")).sessionId, sessionId);
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  await page.screenshot({ path: join(artifacts, "packaged-hosted-lifecycle.png") });
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ platform: process.platform, arch: process.arch, version: pkg.version,
    scope: "Locally packaged app directory, cached verified Node/dependency runtime, pre-staged exact plugin tgz; actual sandboxed Electron renderer, standalone Node host and plugin worker",
    archiveSha256: createHash("sha256").update(bytes).digest("hex"), checks: ["enable-and-native-draw", "native-undo-redo", "Chinese-text-keyboard-insertion-not-OS-IME", "Chinese-workspace-save", "native-PNG-download", "same-version-reopen", "disable-reenable-preserves-scene-file-and-host-identities"],
    limitations: ["No registry install/version update, native file dialog, OS IME, app restart recovery or cross-platform acceptance", "No retained SDK object inspection across backend process; backend PID/session ID invariants only"], pageErrors: errors, externalRequests: external }, null, 2));
  console.log("Packaged hosted editor smoke passed");
} catch (error) {
  console.error("Hosted desktop failed in phase:", phase);
  if (page) await page.screenshot({ path: join(artifacts, "failure.png"), timeout: 4000 }).catch(() => {});
  throw error;
} finally {
  if (electron) {
    await electron.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 2, checkboxChecked: false }); }).catch(() => {});
    await electron.close().catch(() => {});
  }
  // The test owns only this isolated launcher's nonce; never terminate another profile.
  try {
    const current = JSON.parse(await readFile(join(agentDir, "pi-web/launcher.json"), "utf8"));
    await writeFile(join(agentDir, "pi-web/launcher.stop"), current.nonce);
    for (let i = 0; i < 150; i++) { try { process.kill(current.pid, 0); } catch { break; } await new Promise(resolve => setTimeout(resolve, 100)); }
    assert.throws(() => process.kill(current.pid, 0), "Isolated backend must exit before deleting its profile");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  await rm(temporary, { recursive: true, force: true });
}
