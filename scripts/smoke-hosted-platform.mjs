// Independent packaged focus/connection-loss probe. No native IME/dialog claim.
import assert from "node:assert/strict";
import { _electron, expect } from "@playwright/test";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { HostedPluginInstaller } from "../src/host/server/plugins/hosted/installer.ts";
assert.ok(process.env.HOSTED_EXCALIDRAW_TGZ);
assert.ok(process.env.PI_WEB_DESKTOP_EXECUTABLE);
const root = await realpath(await mkdtemp(join(tmpdir(), "ori41-platform-")));
const home = join(root, "home"), agent = join(root, "agent"), hosted = join(agent, "pi-web/hosted");
await mkdir(home);
const bytes = await readFile(process.env.HOSTED_EXCALIDRAW_TGZ);
const sha = createHash("sha256").update(bytes).digest("hex");
assert.equal(sha, process.env.HOSTED_EXCALIDRAW_SHA256 || "932c697f49d87855d5ddc46786c9d0d8ee7b52f64f95af266c46d18ce84d53d5");
const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url)));
const installer = new HostedPluginInstaller({ root: join(hosted, "packages"), hostVersion: pkg.version, fetch: async () => { throw Error("Offline fixed fixture"); } });
await installer.installArchive("@chengzhiyi/pi-excalidraw", bytes, "sha512-" + createHash("sha512").update(bytes).digest("base64"), "0.1.0");
await writeFile(join(hosted, "host-version.json"), JSON.stringify({ version: pkg.version }));
const env = { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agent, PI_WEB_SENTRY_ENABLED: "false", PI_WEBAPP_AUTO_OPEN: "0", PI_WEBAPP_DESKTOP_UPDATE_CHECK: "manual", PATH: process.platform === "win32" ? `${process.env.SystemRoot}\\System32` : "/usr/bin:/bin" };
for (const key of ["NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "PI_WEBAPP_PLUGIN_DEV_ROOTS"]) delete env[key];
let app, page;
const errors = [], completed = [];
const stage = name => { completed.push(name); console.log("PASS", name); };
try {
  app = await _electron.launch({ executablePath: process.env.PI_WEB_DESKTOP_EXECUTABLE, args: [`--user-data-dir=${join(root, "electron")}`], env, timeout: 60_000 });
  await app.context().addInitScript(() => { if (location.protocol === "http:") localStorage.setItem("pi-web-locale", "en"); });
  page = await app.firstWindow({ timeout: 70_000 }); page.setDefaultTimeout(15_000);
  page.on("pageerror", error => errors.push(error.message));
  await page.getByRole("button", { name: /^(Close Pi settings|关闭 Pi 设置)$/ }).click({ timeout: 45_000 });
  const state = JSON.parse(await readFile(join(agent, "pi-web/launcher.json")));
  const address = new URL(state.url), headers = { Authorization: "Bearer " + address.hash.slice(1), Origin: address.origin, "Content-Type": "application/json" };
  const request = async (path, input) => {
    const response = await fetch(address.origin + path, { headers, ...(input ? { method: "POST", body: JSON.stringify(input) } : {}) });
    assert.equal(response.status, 200, path); return response.json();
  };
  const id = "@chengzhiyi/pi-excalidraw", sessionId = (await request("/api/session")).sessionId;
  const catalog = async () => (await request("/api/hosted-plugins")).plugins[0];
  const action = async (action, input) => request("/api/hosted-plugins/action", { pluginId: id, generation: (await catalog()).generation, sessionId, action, input });
  const ready = new Map(), resumeCommands = new Set(), resumedAcks = new Set();
  page.on("response", async response => {
    if (new URL(response.url()).pathname === "/api/hosted-plugins/views" && response.request().postDataJSON()?.operation === "pollMany" && response.status() === 200) {
      const inputs = response.request().postDataJSON().views;
      const data = await response.json().catch(() => ({}));
      for (const [i, result] of (data.replies ?? []).entries()) for (const command of result.reply?.commands ?? []) if (command.type === "resume") resumeCommands.add(`${inputs[i].mountId}:${command.id}`);
    }
    if (new URL(response.url()).pathname === "/api/hosted-plugins/views" && response.request().method() === "POST" && response.status() === 200) {
      const input = response.request().postDataJSON();
      if (input.operation === "change") { if (!input.busy) ready.set(input.mountId, input.generation); else ready.delete(input.mountId); }
      if (input.operation === "ack" && input.ok && resumeCommands.has(`${input.mountId}:${input.commandId}`)) resumedAcks.add(input.mountId);
    }
  });
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  await page.locator("[data-hosted-management]").getByRole("button", { name: "Enable", exact: true }).click();
  await expect(page.locator("[data-hosted-management]")).toContainText("Installed · Enabled");
  await page.getByRole("button", { name: /^(当前会话|Current session)$/, exact: true }).click();
  await page.getByRole("button", { name: "Open right sidebar", exact: true }).click();
  await page.getByRole("button", { name: "Excalidraw", exact: true }).click();
  const canvas = page.frameLocator('iframe[title="Excalidraw workspace"]').locator("canvas.interactive");
  await expect(canvas).toBeVisible(); await canvas.click(); await page.keyboard.press("r");
  const box = await canvas.boundingBox(); assert.ok(box);
  await page.mouse.move(box.x + 180, box.y + 180); await page.mouse.down(); await page.mouse.move(box.x + 300, box.y + 260); await page.mouse.up();
  await expect.poll(async () => (await action("list", {})).length).toBe(1);
  const draft = (await action("list", {}))[0].id;
  await expect.poll(async () => (await action("get", { id: draft })).scene.elements.length).toBe(1);
  stage("packaged-native-pointer-draw");
  const before = (await action("get", { id: draft })).scene;
  const composer = page.getByRole("textbox", { name: "Send a message to the current Pi session", exact: true });
  await composer.fill("focus-isolation"); await composer.press("ControlOrMeta+a"); await composer.press("ArrowRight"); await composer.press("ControlOrMeta+z");
  assert.deepEqual((await action("get", { id: draft })).scene, before);
  await composer.fill(""); stage("composer-shortcuts-do-not-mutate-drawing");
  const generation = (await catalog()).generation;
  await expect.poll(async () => {
    const mounts = await page.locator('iframe[title^="Excalidraw "]').evaluateAll(frames => frames.map(frame => new URL(frame.src).searchParams.get("mountId")));
    return mounts.length === 2 && mounts.every(mount => ready.get(mount) === generation);
  }).toBe(true);
  const locator = page.locator('iframe[title="Excalidraw workspace"]'), identity = await locator.getAttribute("src");
  let blocked = 0;
  const loseAck = async route => {
    if (route.request().method() === "POST" && route.request().postDataJSON()?.operation === "ack") {
      blocked++; await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Injected connection loss" }) });
    } else await route.continue();
  };
  await page.route("**/api/hosted-plugins/views", loseAck);
  try {
    const response = await fetch(address.origin + "/api/hosted-plugins/manage", { method: "POST", headers, body: JSON.stringify({ pluginId: id, operation: "enable", reopenEditors: true }) });
    assert.equal(response.status, 409, await response.text()); assert.ok(blocked > 0);
    assert.equal((await catalog()).generation, generation); assert.equal(await locator.getAttribute("src"), identity);
    assert.deepEqual((await action("get", { id: draft })).scene, before);
    stage("actual-freeze-ack-loss-fails-closed-retains-realm-scene-generation");
  } finally { await page.unroute("**/api/hosted-plugins/views", loseAck); }
  // A failed write is not automatically retried. Explicitly restart each failed
  // view reader, and observe real resumed status before retrying the switch.
  const retry = page.getByRole("button", { name: "Retry view connection", exact: true });
  await expect(retry).not.toHaveCount(0);
  while (await retry.count()) await retry.first().click();
  await expect.poll(async () => page.locator('[data-hosted-plugin] > [role="alert"]').allTextContents()).toEqual([]);
  // The resume ACK (not a delay or catalog read) proves the retained frozen realm
  // has consumed the cancellation before another generation switch begins.
  await expect.poll(() => resumedAcks.size).toBe(2);
  await request("/api/hosted-plugins/manage", { pluginId: id, operation: "enable", reopenEditors: true });
  assert.equal((await catalog()).generation, generation + 1);
  await expect(canvas).toBeVisible(); assert.deepEqual((await action("get", { id: draft })).scene, before);
  assert.equal((await request("/api/session")).sessionId, sessionId);
  const after = JSON.parse(await readFile(join(agent, "pi-web/launcher.json")));
  assert.equal(after.pid, state.pid); assert.equal(after.piPid, state.piPid);
  stage("reconnected-real-generation-switch-scene-session-pids-retained");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ platform: process.platform, arch: process.arch, archiveSha256: sha, completed, errors, limitations: ["Not native IME/dialogs/undo acceptance", "503 fault injection, not OS network outage"] }, null, 2));
} finally {
  if (app) { await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 2, checkboxChecked: false }); }).catch(() => {}); await app.close(); }
  try {
    const state = JSON.parse(await readFile(join(agent, "pi-web/launcher.json")));
    await writeFile(join(agent, "pi-web/launcher.stop"), state.nonce);
    for (let i = 0; i < 150; i++) { try { process.kill(state.pid, 0); } catch { break; } await new Promise(resolve => setTimeout(resolve, 100)); }
    assert.throws(() => process.kill(state.pid, 0), "Owned backend must exit before profile deletion");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  await rm(root, { recursive: true, force: true });
}
