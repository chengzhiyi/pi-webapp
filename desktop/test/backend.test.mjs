import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DesktopBackend, externalAddress, localAddress, runtimeEnvironment, sameDocument } from "../backend.mjs";

const token = "a".repeat(32);
const address = `http://127.0.0.1:12345/#${token}`;
const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
const state = { pid: 123, nonce: "control-nonce", url: address, version: pkg.version, bridgeVersion: 1, runtimeKind: "npm" };

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pi-desktop 中文 "));
  const backend = new DesktopBackend({ agentDir: directory, version: pkg.version, node: process.execPath,
    launcher: fileURLToPath(new URL("../../bin/pi-webapp.mjs", import.meta.url)), piCli: join(directory, "fake-pi.mjs"),
    npmCli: "unused-npm-cli", cwd: directory, env: { PATH: "", PI_CODING_AGENT_DIR: directory, PI_WEB_SENTRY_ENABLED: "false" },
    timeoutMs: 10000, fetchRequest: async () => ({ ok: true, json: async () => ({ current: pkg.version }) }),
    isAlive: () => true, ...overrides });
  t.after(async () => { await backend.stop(); await rm(directory, { recursive: true, force: true }); });
  await mkdir(join(directory, "pi-web"));
  return backend;
}

async function save(backend, value) { await writeFile(backend.statePath, JSON.stringify(value)); }

test("desktop only accepts authenticated loopback backend URLs", () => {
  assert.equal(localAddress(address).href, address);
  for (const value of ["https://127.0.0.1:12345/", `http://localhost:12345/#${token}`, `http://evil.test:12345/#${token}`,
    `http://user@127.0.0.1:12345/#${token}`, `http://127.0.0.1:12345/path#${token}`,
    `http://127.0.0.1:12345/?token=x#${token}`, "file:///tmp/app", "http://127.0.0.1:12345/#short"]) {
    assert.throws(() => localAddress(value));
  }
});

test("navigation stays in the UI document and external links are protocol-allowlisted", () => {
  assert.equal(sameDocument(address, address), true);
  assert.equal(sameDocument("http://127.0.0.1:12345/#another", address), true);
  for (const value of ["http://127.0.0.1:12345/api/update", "http://evil.test/", "file:///tmp/x", "garbage"]) {
    assert.equal(sameDocument(value, address), false);
  }
  assert.equal(externalAddress("https://example.com/login?code=example"), "https://example.com/login?code=example");
  for (const value of ["file:///tmp/app", "javascript:alert(1)", "shell:open", "vscode://x", "https://user:secret@example.com/", "garbage"]) {
    assert.equal(externalAddress(value), null);
  }
});

test("runtime environment uses bundled Node/npm and removes inherited control flags", () => {
  const env = runtimeEnvironment({ PATH: "user-path", NODE_OPTIONS: "--inspect", NODE_PATH: "other", ELECTRON_RUN_AS_NODE: "1",
    PI_WEBAPP_RESTART_TOKEN: "secret", PI_WEBAPP_RESTART_PORT: "123", PI_WEBAPP_PLUGIN_DEV_ROOTS: "other", PI_CODING_AGENT_DIR: "agent" },
  { node: "/runtime/bin/node", npmCli: "/runtime/npm-cli.js", piCli: "/runtime/pi-cli.js" });
  assert.equal(env.PATH, `/runtime/bin${delimiter}user-path`);
  assert.equal(env.PI_WEBAPP_RUNTIME, "desktop");
  assert.equal(env.PI_WEBAPP_AUTO_OPEN, "0");
  assert.equal(env.npm_execpath, "/runtime/npm-cli.js");
  assert.equal(env.PI_WEBAPP_PI_CLI, "/runtime/pi-cli.js");
  assert.equal(env.PI_CODING_AGENT_DIR, "agent");
  for (const key of ["NODE_OPTIONS", "NODE_PATH", "ELECTRON_RUN_AS_NODE", "PI_WEBAPP_RESTART_TOKEN", "PI_WEBAPP_RESTART_PORT", "PI_WEBAPP_PLUGIN_DEV_ROOTS"]) assert.equal(env[key], undefined);
});

test("a compatible healthy service is reused, never owned or stopped", async t => {
  let spawned = false;
  const backend = await fixture(t, { spawnProcess: () => { spawned = true; throw new Error("must not spawn"); } });
  await save(backend, state);
  assert.deepEqual(await backend.connect(), state);
  assert.equal(backend.owned, false);
  assert.equal(spawned, false);
  await backend.stop();
  await assert.rejects(readFile(backend.stopPath), { code: "ENOENT" });
});

test("health check sends token only in the authorization header", async t => {
  const backend = await fixture(t, { fetchRequest: async (url, options) => {
    assert.equal(url, "http://127.0.0.1:12345/api/update/version");
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    assert.equal(options.redirect, "error");
    return { ok: true, json: async () => ({ current: pkg.version }) };
  } });
  await save(backend, state);
  await backend.connect();
});

test("old/unknown versions and unhealthy services are not replaced", async t => {
  const backend = await fixture(t);
  for (const [badState, pattern] of [[{ ...state, version: "0.0.1" }, /版本不兼容/], [{ ...state, bridgeVersion: 99 }, /启动器协议/]]) {
    await save(backend, badState);
    await assert.rejects(backend.connect(), pattern);
    assert.deepEqual(JSON.parse(await readFile(backend.statePath, "utf8")), JSON.parse(JSON.stringify(badState)));
  }
  backend.fetchRequest = async () => ({ ok: false });
  await save(backend, state);
  await assert.rejects(backend.connect(), /健康检查/);
  assert.equal(backend.owned, false);
});

test("stale dead service state can be cleaned without signaling a process", async t => {
  const backend = await fixture(t, { isAlive: () => false });
  await save(backend, state);
  assert.equal(await backend.existing(), null);
  await assert.rejects(readFile(backend.statePath), { code: "ENOENT" });
});

test("stop only targets the exact owned nonce, never a replacement service", async t => {
  const backend = await fixture(t);
  backend.state = state;
  backend.owned = true;
  await save(backend, { ...state, nonce: "replacement" });
  await backend.stop();
  await assert.rejects(readFile(backend.stopPath), { code: "ENOENT" });
  await save(backend, state);
  const stopped = backend.stop();
  for (let attempt = 0; attempt < 100; attempt++) {
    try { assert.equal(await readFile(backend.stopPath, "utf8"), state.nonce); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 5)); }
  }
  await unlink(backend.statePath);
  await stopped;
  assert.equal(backend.owned, false);
});

test("spawn errors are bounded and the log descriptor is closed", async t => {
  const child = new EventEmitter();
  child.kill = () => {};
  child.unref = () => {};
  const backend = await fixture(t, { spawnProcess: () => { queueMicrotask(() => child.emit("error", new Error("ENOENT"))); return child; } });
  await assert.rejects(backend.connect(), /运行环境/);
});

test("standalone Node starts Pi CLI without PATH and a second client shares the service", { timeout: 20000 }, async t => {
  const backend = await fixture(t, { isAlive: pid => { try { process.kill(pid, 0); return true; } catch { return false; } }, fetchRequest: fetch });
  await writeFile(backend.piCli, `import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
const token = '${token}';
const server = createServer((req,res) => { if(req.headers.authorization !== 'Bearer '+token) { res.writeHead(401); res.end(); return; } res.setHeader('Content-Type','application/json');res.end(JSON.stringify({current:${JSON.stringify(pkg.version)}})); });
createInterface({input:process.stdin}).on('line', line => {
 const request=JSON.parse(line);
 if(request.type==='get_commands') console.log(JSON.stringify({type:'response',id:request.id,success:true,data:{commands:[{name:'web',source:'extension',sourceInfo:{path:process.argv[process.argv.indexOf('-e')+1]}}]}}));
 else server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({type:'extension_ui_request',method:'notify',message:'pi-webapp: http://127.0.0.1:'+server.address().port+'/#'+token})));
});
process.stdin.on('end',()=>server.close(()=>process.exit(0)));
`);
  t.after(() => backend.stop());
  const first = await backend.connect();
  assert.equal(backend.owned, true);
  assert.equal(first.runtimeKind, "desktop");
  assert.equal(first.version, pkg.version);
  const second = new DesktopBackend({ ...backend, spawnProcess: () => { throw new Error("unexpected duplicate service"); } });
  const reused = await second.connect();
  assert.equal(reused.pid, first.pid);
  assert.equal(second.owned, false);
  await second.stop();
  assert.equal((await backend.readState()).nonce, first.nonce);
  await backend.stop();
  assert.equal(await backend.readState(), null);
  // A simultaneous second launch must lose the same lock, then attach to the winner.
  const racer = new DesktopBackend({ ...backend });
  try {
    const [left, right] = await Promise.all([backend.connect(), racer.connect()]);
    assert.equal(left.pid, right.pid);
    assert.equal(Number(backend.owned) + Number(racer.owned), 1);
  } finally { await backend.stop(); await racer.stop(); }
  assert.equal(await backend.readState(), null);
  backend.fetchRequest = async () => ({ ok: false });
  await assert.rejects(backend.connect(), /健康检查/);
  assert.equal(await backend.readState(), null, "failed readiness must reap the owned supervisor and Pi");
});
