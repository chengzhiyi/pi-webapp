// Real built host + SDK + desktop-managed launcher. Only npm's release transport
// is a local fixture; this does not install a native Electron app or call a model.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { chromium, expect } from "@playwright/test";

const exec = promisify(execFile), source = resolve(process.cwd());
const root = await mkdtemp(join(tmpdir(), "pi-real-alpha-recovery-"));
const agent = join(root, "agent"), initial = join(root, "initial");
const configPath = join(root, "release-fixture.json"), npmCli = join(root, "npm-cli.js");
const evidence = { kind: "built-host-real-sdk-real-launcher; fixture-npm-release-transport", results: [] };
let browser;
const base = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
await mkdir(initial);
for (const path of ["bin", "desktop", "dist", "web/dist"]) await cp(join(source, path), join(initial, path), { recursive: true });
await writeFile(join(initial, "package.json"), JSON.stringify(base));
// Initial dependencies are the checked development closure. Candidate dependencies
// own their SDK/native payloads, as the desktop release validator requires.
const fixtureSource = `
const fs=require('node:fs'),path=require('node:path');
const c=JSON.parse(fs.readFileSync(${JSON.stringify(configPath)},'utf8'));
const args=process.argv.slice(2);
if(args[0]==='view'){
 const value=args.includes('peerDependencies')?JSON.parse(fs.readFileSync(path.join(c.source,'package.json'),'utf8')).peerDependencies:args.includes('dist-tags')?{latest:c.stable,alpha:c.target}:c.stable;
 console.log(JSON.stringify(value));process.exit(0)
}
if(args[0]!=='install')throw new Error('Unexpected fixture npm operation');
const prefix=args[args.indexOf('--prefix')+1], nm=path.join(prefix,'node_modules'),pkg=path.join(nm,'pi-webapp');
fs.mkdirSync(pkg,{recursive:true});
for(const name of ['bin','desktop','dist','web/dist'])fs.cpSync(path.join(c.source,name),path.join(pkg,name),{recursive:true});
const manifest=JSON.parse(fs.readFileSync(path.join(c.source,'package.json'),'utf8'));manifest.version=c.target;
fs.writeFileSync(path.join(pkg,'package.json'),JSON.stringify(manifest));
for(const item of fs.readdirSync(path.join(c.source,'node_modules'),{withFileTypes:true})){
 if(item.name==='pi-webapp'||item.name==='.bin'||item.name.startsWith('.'))continue;
 const from=path.join(c.source,'node_modules',item.name),to=path.join(nm,item.name);
 if(item.name==='@earendil-works'||item.name==='node-pty')fs.cpSync(from,to,{recursive:true});
 else fs.symlinkSync(from,to,'dir');
}
if(c.crash)fs.writeFileSync(path.join(pkg,'dist','extension.js'),'throw new Error("isolated candidate startup failure");');
console.log('fixture distribution staged');
`;
await writeFile(npmCli, fixtureSource);
const { symlink } = await import("node:fs/promises");
await symlink(join(source, "node_modules"), join(initial, "node_modules"), "dir");
let target = "0.2.0-alpha.1";
const configure = async crash => writeFile(configPath, JSON.stringify({ source, stable: base.version, target, crash }));
await configure(false);
const env = { ...process.env, PI_CODING_AGENT_DIR: agent, PI_WEBAPP_AUTO_OPEN: "0", PI_WEBAPP_PLUGIN_DEV_ROOTS: "",
  PI_WEB_SENTRY_ENABLED: "false", PI_WEBAPP_RUNTIME: "desktop", PI_WEBAPP_DESKTOP_PACKAGE_UPDATES: "1",
  PI_WEBAPP_DESKTOP_RELEASE_CHANNELS: "1", PI_WEBAPP_DESKTOP_VERSION: base.version, PI_WEBAPP_DESKTOP_BUILD: "1", npm_execpath: npmCli };
for (const key of ["PI_WEBAPP_RESTART_PORT", "PI_WEBAPP_RESTART_TOKEN", "PI_WEBAPP_LAUNCHER_NONCE", "PI_WEBAPP_PI_CLI", "NODE_OPTIONS", "NODE_PATH"]) delete env[key];
const launcher = join(initial, "bin", "pi-webapp.mjs");
const statePath = join(agent, "pi-web", "launcher.json");
let address;
async function state() {
  const s = JSON.parse(await readFile(statePath, "utf8"));
  address = new URL(s.url); return s;
}
async function request(path, input) {
  await state();
  const r = await fetch(address.origin + path, { method: input ? "POST" : "GET", signal: AbortSignal.timeout(35_000),
    headers: { Authorization: `Bearer ${address.hash.slice(1)}`, Origin: address.origin, "Content-Type": "application/json" },
    ...(input ? { body: JSON.stringify(input) } : {}) });
  const value = await r.json(); assert.ok(r.ok, `${path}: ${r.status} ${JSON.stringify(value)}`); return value;
}
async function sessionId() {
  await state();
  const r = await fetch(address.origin + "/api/events", { headers: { Authorization: `Bearer ${address.hash.slice(1)}` }, signal: AbortSignal.timeout(5000) });
  const reader = r.body.getReader(); let raw = "";
  while (!raw.includes("\n")) { const next = await reader.read(); if (next.done) break; raw += new TextDecoder().decode(next.value); }
  await reader.cancel(); return JSON.parse(raw.split("\n")[0]).session.sessionId;
}
async function waitVersion(expected, previousPid) {
  const end = Date.now() + 45_000; let last;
  while (Date.now() < end) {
    try {
      const s = await state(), v = await request("/api/update/version");
      if (v.current === expected && s.piPid !== previousPid) return s;
      last = JSON.stringify({ version: v.current, sameChild: s.piPid === previousPid });
    } catch (error) { last = error.message; }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Expected actual ${expected} child: ${last}`);
}
try {
  await exec(process.execPath, [launcher, "start"], { cwd: root, env, timeout: 45_000, maxBuffer: 1024 * 1024 });
  const first = await state();
  browser = await chromium.launch();
  const page = await browser.newPage();
  const browserErrors = []; page.on("pageerror", error => browserErrors.push(error.message));
  await page.addInitScript(() => localStorage.setItem("pi-web-locale", "en"));
  await page.goto(first.url);
  // A clean, unauthenticated test profile opens the ordinary model setup dialog.
  // Navigate its General section rather than bypassing that overlay.
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "General", exact: true }).click();
  await page.getByRole("button", { name: "Update preference", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Preview (including alpha)", exact: true }).click();
  await expect(page.getByRole("region", { name: "App updates", exact: true })).toContainText(`Target version ${target}`);
  let status = await request("/api/update");
  assert.equal(status.channel, "alpha"); assert.equal(status.latest, target);
  const reloaded = page.waitForEvent("load", { timeout: 45_000 });
  await page.getByRole("button", { name: "Update and restart", exact: true }).click();
  const alpha = await waitVersion(target, first.piPid);
  await reloaded;
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "General", exact: true }).click();
  await expect(page.getByRole("region", { name: "App updates", exact: true })).toContainText(`Current version ${target}`);
  await expect(page.getByRole("button", { name: "Update preference", exact: true })).toContainText("Preview");
  if (process.env.PI_RECOVERY_SMOKE_OUTPUT) {
    await mkdir(process.env.PI_RECOVERY_SMOKE_OUTPUT, { recursive: true });
    await page.screenshot({ path: join(process.env.PI_RECOVERY_SMOKE_OUTPUT, "actual-alpha-after-restart.png"), fullPage: true });
  }
  assert.deepEqual(browserErrors, []);
  await browser.close(); browser = undefined;
  status = await request("/api/update");
  assert.equal(status.current, target); assert.equal(status.channel, "alpha");
  assert.equal(JSON.parse(await readFile(join(agent, "pi-web", "update-transaction.json"), "utf8")).phase, "committed");
  evidence.results.push({ case: "actual App alpha picker/install, real backend restart, displayed/running version, persisted channel and health commit", pass: true });
  const working = target;
  target = "0.2.0-alpha.2"; await configure(true);
  await request("/api/update", { sessionId: await sessionId(), channel: "alpha", version: target });
  await waitVersion(working, alpha.piPid);
  status = await request("/api/update");
  assert.equal(status.current, working); assert.equal(status.channel, "alpha");
  assert.ok(status.recovery?.canCancel, "failed launch must expose an owned recovery action");
  await request("/api/update/cancel", { sessionId: await sessionId() });
  assert.equal((await request("/api/hosted-plugins")).plugins[0].installed, false);
  evidence.results.push({ case: "candidate startup failure, actual launcher fallback, exact journal cancellation, old host usable", pass: true });
  target = "0.2.0-alpha.3"; await configure(false);
  const fallback = await state();
  await request("/api/update", { sessionId: await sessionId(), channel: "alpha", version: target });
  await waitVersion(target, fallback.piPid);
  assert.equal((await request("/api/update")).channel, "alpha");
  evidence.results.push({ case: "fresh alpha upgrade succeeds after failed launch and recovery", pass: true });
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  if (browser && process.env.PI_RECOVERY_SMOKE_OUTPUT) {
    await mkdir(process.env.PI_RECOVERY_SMOKE_OUTPUT, { recursive: true });
    for (const context of browser.contexts()) for (const page of context.pages()) {
      await page.screenshot({ path: join(process.env.PI_RECOVERY_SMOKE_OUTPUT, "smoke-failure.png"), fullPage: true }).catch(() => {});
    }
  }
  const log = await readFile(join(agent, "pi-web", "launcher.log"), "utf8").catch(() => "");
  console.error(log.replace(/https?:\/\/[^\s"']+/g, "[redacted URL]").slice(-7000));
  throw error;
} finally {
  await browser?.close();
  await exec(process.execPath, [launcher, "stop"], { cwd: root, env, timeout: 25_000 }).catch(error => console.error("Isolated smoke cleanup failed:", error.message));
  if (process.env.PI_RECOVERY_SMOKE_KEEP === "1") console.log(`Isolated evidence retained: ${root}`);
  else await rm(root, { recursive: true, force: true });
}
