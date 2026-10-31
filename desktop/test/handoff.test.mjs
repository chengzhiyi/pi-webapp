import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DesktopBackend } from "../backend.mjs";
import { writeDesktopRelease } from "../managed-release.mjs";
import { stageRuntime } from "./fixtures/runtime.mjs";

const token = "h".repeat(32);
const address = `http://127.0.0.1:12345/#${token}`;
const oldState = { pid: 12345, nonce: "old-supervisor-owner", url: address, version: "0.1.44",
  runtimeKind: "desktop", bridgeVersion: 1, desktopProtocolVersion: 1, launcherHandoffProtocol: 1, desktopReleaseChannels: false };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t, { unsupported = false, status = 202, phase = "stopped", successorCapabilities = true,
  successorWireCapabilities = successorCapabilities, successorAddress = address } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-desktop-handoff 中文 "));
  const statePath = join(root, "pi-web", "launcher.json"), handoffPath = join(root, "pi-web", "launcher-handoff.json");
  const selection = await stageRuntime(root, "0.1.44");
  await writeDesktopRelease(root, selection);
  const initial = { ...oldState, ...(unsupported ? { launcherHandoffProtocol: undefined } : {}) };
  await writeFile(statePath, JSON.stringify(initial));
  await writeFile(join(root, "pi-web", "update-preferences.json"), JSON.stringify({ channel: "alpha" }));
  let oldAlive = true, posted, nextPid = 23456;
  const requests = [], launches = [], pending = [], alivePids = new Set([nextPid]);
  const f = { statePath, handoffPath, selection, requests, launches, initial,
    get posted() { return posted; }, setOldAlive(value) { oldAlive = value; },
    setOtherAlive(pid) { alivePids.add(pid); },
    async receipt(overrides = {}) {
      await writeFile(handoffPath, JSON.stringify({ schema: 1, protocol: 1, pid: oldState.pid, nonce: oldState.nonce,
        requestId: posted.requestId, phase, ...overrides }));
    },
    async finishOld() { await f.receipt(); await rm(statePath, { force: true }); oldAlive = false; },
    onPost: null, onSpawn: null,
  };
  const backend = new DesktopBackend({ agentDir: root, version: "0.1.39", node: process.execPath,
    launcher: join(root, "bundled", "bin", "pi-webapp.mjs"), piCli: join(root, "bundled", "pi-cli.js"), npmCli: join(root, "npm-cli.js"), cwd: root,
    env: { PI_CODING_AGENT_DIR: root, PI_WEBAPP_DESKTOP_VERSION: "0.1.39", PI_WEBAPP_DESKTOP_BUILD: "12", PATH: "fixture-path",
      PI_WEBAPP_DESKTOP_RELEASE_CHANNELS: "0", PI_WEBAPP_RESTART_TOKEN: "untrusted-inherited-token", PI_WEBAPP_RESTART_PORT: "9999" },
    timeoutMs: 700, isAlive: pid => pid === oldState.pid ? oldAlive : alivePids.has(pid),
    fetchRequest: async (url, options = {}) => {
      requests.push({ url, options });
      if (url === "http://127.0.0.1:12345/api/desktop/handoff") {
        posted = JSON.parse(options.body);
        if (status !== 202) return json({ error: status === 409 ? "后台聊天或终端仍在运行，交接被拒绝" : "Unsupported launcher handoff" }, status);
        if (f.onPost) await f.onPost(); else await f.finishOld();
        return json({ accepted: true, protocol: 1, requestId: posted.requestId }, 202);
      }
      const current = JSON.parse(await readFile(statePath, "utf8"));
      if (url.endsWith("/api/update/version")) return json({ current: current.version, desktopProtocolVersion: 1,
        ...(unsupported ? {} : { desktopHandoffProtocol: 1, launcher: { version: current.version, releaseChannels: current.pid !== oldState.pid && successorWireCapabilities, desktopShell: {version:"0.1.39",build:"12"} } }) });
      if (url.endsWith("/api/update")) return json({ current: current.version, channel: "alpha", canRestart: current.pid !== oldState.pid && successorCapabilities,
        desktopShell: { version: "0.1.28", build: "10" }, launcherHandoff: { supported: !unsupported, required: current.pid === oldState.pid || !successorCapabilities } });
      if (url.endsWith("/api/session")) return json({ sessionId: "session", schemaVersion: 1, cwd: root, idle: true, messages: [], pluginEntries: [] });
      throw new Error(`unexpected fixture request: ${url}`);
    },
    spawnProcess: (file, args, options) => {
      launches.push({ file, args, options });
      assert.equal(oldAlive, false, "never spawn a replacement while the old supervisor remains alive");
      const child = new EventEmitter();
      Object.assign(child, { pid: nextPid, connected: true, disconnect() { child.connected = false; }, unref() {},
        kill() { assert.fail("handoff must never force-stop any process"); } });
      setImmediate(async () => {
        try {
          if (f.onSpawn) { await f.onSpawn(child); return; }
          const successor = { ...oldState, pid: nextPid, nonce: "new-shell-owner", desktopReleaseChannels: successorCapabilities, url: successorAddress };
          await writeFile(statePath, JSON.stringify(successor));
          child.emit("message", { type: "ready", url: successorAddress });
        } catch (error) { child.emit("error", error); }
      });
      return child;
    } });
  backend.state = initial; backend.owned = false;
  t.after(async () => {
    oldAlive = false;
    await rm(statePath, { force: true });
    await Promise.allSettled(pending);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return { ...f, backend, root, get posted() { return posted; }, start() {
    const promise = backend.handoff(); promise.catch(() => {}); pending.push(promise); return promise;
  }, set onPost(value) { f.onPost = value; }, set onSpawn(value) { f.onSpawn = value; } };
}

test("explicit handoff authenticates the exact owner, preserves the selected package and URL, and starts with current shell capabilities", async t => {
  const f = await fixture(t);
  const result = await f.start();
  const post = f.requests.find(request => request.url.endsWith("/api/desktop/handoff"));
  assert.ok(post);
  assert.equal(post.options.method, "POST");
  assert.equal(post.options.headers.Authorization, `Bearer ${token}`);
  assert.equal(post.options.headers.Origin, new URL(address).origin);
  assert.match(f.posted.requestId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i);
  assert.deepEqual(Object.keys(f.posted).sort(), ["nonce", "requestId"]);
  assert.equal(f.posted.nonce, oldState.nonce);
  assert.equal(result.url, address);
  assert.equal(result.version, "0.1.44");
  assert.equal(f.backend.owned, true);
  assert.equal(f.launches.length, 1);
  assert.equal(await realpath(f.launches[0].args[0]), await realpath(f.selection.launcher));
  const env = f.launches[0].options.env;
  assert.equal(env.PI_WEBAPP_DESKTOP_BUILD, "12");
  assert.equal(env.PI_WEBAPP_DESKTOP_PACKAGE_UPDATES, "1");
  assert.equal(env.PI_WEBAPP_DESKTOP_RELEASE_CHANNELS, "1");
  assert.equal(env.PI_WEBAPP_RESTART_TOKEN, token);
  assert.equal(env.PI_WEBAPP_RESTART_PORT, "12345");
  assert.equal((await readFile(join(f.root, "pi-web", "update-preferences.json"), "utf8")), JSON.stringify({ channel: "alpha" }));
  await assert.rejects(readFile(join(f.root, "pi-web", "launcher.stop")), { code: "ENOENT" });
});

test("a stopped receipt and missing state do not authorize a replacement until the exact old PID has exited", async t => {
  const f = await fixture(t);
  f.onPost = async () => { await f.receipt(); await rm(f.statePath); };
  const completed = f.start();
  for (let i = 0; !f.posted && i < 100; i++) await pause(5);
  assert.ok(f.posted);
  await pause(30);
  assert.equal(f.launches.length, 0);
  f.setOldAlive(false);
  assert.equal((await completed).url, address);
});

for (const status of [401, 403, 409]) test(`handoff rejection ${status} preserves the shared owner without a stop or spawn`, async t => {
  const f = await fixture(t, { status });
  await assert.rejects(f.start());
  assert.deepEqual(JSON.parse(await readFile(f.statePath, "utf8")), oldState);
  assert.equal(f.backend.owned, false);
  assert.equal(f.launches.length, 0);
  assert.equal(JSON.parse(await readFile(join(f.root, "pi-web", "desktop-handoff.json"), "utf8")).cancelled, true,
    "an explicit HTTP refusal must leave a durable cancelled intent, not an ambiguous pending transfer");
  await assert.rejects(readFile(join(f.root, "pi-web", "launcher.stop")), { code: "ENOENT" });
});

test("a refused plugin drain never falls back to force stopping the shared service", async t => {
  const f = await fixture(t, { phase: "refused" });
  f.onPost = () => f.receipt();
  await assert.rejects(f.start());
  assert.deepEqual(JSON.parse(await readFile(f.statePath, "utf8")), oldState);
  assert.equal(f.launches.length, 0);
  assert.equal(f.backend.owned, false);
});

test("an accepted draining request leaves the shared owner intact until its stopped receipt arrives", async t => {
  const f = await fixture(t, { phase: "draining" });
  f.onPost = () => f.receipt();
  const completed = f.start();
  for (let i = 0; !f.posted && i < 100; i++) await pause(5);
  await pause(30);
  assert.equal(f.launches.length, 0);
  assert.equal(f.backend.owned, false);
  await f.receipt({ phase: "stopped" });
  await rm(f.statePath); f.setOldAlive(false);
  assert.equal((await completed).url, address);
});

test("a restarted backend still advertising false preview capability is never reported as a successful handoff", async t => {
  const f = await fixture(t, { successorCapabilities: false });
  await assert.rejects(f.start(), /能力|capabilit/i);
  assert.equal(f.launches.length, 1);
  assert.equal(JSON.parse(await readFile(f.statePath, "utf8")).nonce, "new-shell-owner", "a failed capability check must preserve the running replacement for recovery");
  await assert.rejects(readFile(join(f.root, "pi-web", "launcher.stop")), { code: "ENOENT" });
});

test("a lost HTTP response can resume only its exact durable handoff receipt", async t => {
  const f = await fixture(t);
  f.onPost = async () => { await f.finishOld(); throw new Error("fixture connection reset after acceptance"); };
  const result = await f.start();
  assert.equal(result.url, address);
  assert.equal(f.launches.length, 1);
  assert.equal(f.backend.owned, true);
});

test("an old stopped marker never converts a new request's network failure into accepted handoff", async t => {
  const f = await fixture(t);
  const stale = JSON.stringify({ protocol: 1, nonce: oldState.nonce, pid: oldState.pid,
    requestId: "789791c8-52b8-4988-8e68-a23d46dd36f9", phase: "stopped" });
  await writeFile(f.handoffPath, stale);
  f.onPost = async () => { throw new Error("fixture connection reset before acceptance"); };
  await assert.rejects(f.start());
  assert.equal(f.launches.length, 0);
  assert.equal(f.backend.owned, false);
  assert.equal(await readFile(f.handoffPath, "utf8"), stale);
  assert.deepEqual(JSON.parse(await readFile(f.statePath, "utf8")), oldState);
  const intent = JSON.parse(await readFile(join(f.root, "pi-web", "desktop-handoff.json"), "utf8"));
  assert.notEqual(intent.cancelled, true, "a transport error cannot prove that an in-flight handoff was refused");
});

test("a true state-file capability cannot override the authenticated successor's false runtime capability", async t => {
  const f = await fixture(t, { successorCapabilities: true, successorWireCapabilities: false });
  await assert.rejects(f.start(), /能力|capabilit/i);
  const successor = JSON.parse(await readFile(f.statePath, "utf8"));
  assert.equal(successor.desktopReleaseChannels, true, "exercise a contradiction with authenticated HTTP, not a false file flag");
  assert.equal(successor.nonce, "new-shell-owner");
  await assert.rejects(readFile(join(f.root, "pi-web", "launcher.stop")), { code: "ENOENT" });
});

for (const successorAddress of [`http://127.0.0.1:12346/#${token}`, `http://127.0.0.1:12345/#${"z".repeat(32)}`]) {
  test(`a successor with a different ${new URL(successorAddress).port === "12345" ? "token" : "port"} cannot pass handoff validation`, async t => {
    const f = await fixture(t, { successorAddress });
    await assert.rejects(f.start(), /原地址|address|能力|capabilit/i);
    assert.equal(JSON.parse(await readFile(f.statePath, "utf8")).url, successorAddress);
    await assert.rejects(readFile(join(f.root, "pi-web", "launcher.stop")), { code: "ENOENT" });
  });
}

test("a new owner winning the launch lock after the final empty-state check cannot be inherited as handoff success", async t => {
  const f = await fixture(t);
  const replacement = { ...oldState, pid: 34567, nonce: "racing-owner", desktopReleaseChannels: true };
  f.setOtherAlive(replacement.pid);
  f.onSpawn = async child => {
    await writeFile(f.statePath, JSON.stringify(replacement));
    child.emit("message", { type: "error", message: "lock already claimed" });
  };
  await assert.rejects(f.start(), /接管|交接|owner|handoff|启动|验证/i);
  assert.deepEqual(JSON.parse(await readFile(f.statePath, "utf8")), replacement);
  assert.equal(f.backend.owned, false);
  await assert.rejects(readFile(join(f.root, "pi-web", "launcher.stop")), { code: "ENOENT" });
});

test("a replacement owner appearing after the accepted receipt is preserved instead of being claimed as handoff success", async t => {
  const f = await fixture(t);
  const replacement = { ...oldState, pid: 45678, nonce: "unrelated-winner" };
  f.onPost = async () => { await f.receipt(); await writeFile(f.statePath, JSON.stringify(replacement)); f.setOldAlive(false); };
  await assert.rejects(f.start());
  assert.deepEqual(JSON.parse(await readFile(f.statePath, "utf8")), replacement);
  assert.equal(f.backend.owned, false);
  assert.equal(f.launches.length, 0);
});

for (const mismatch of [{ requestId: "another-request" }, { nonce: "another-owner" }, { pid: 45678 }]) {
  test(`a mismatched ${Object.keys(mismatch)[0]} receipt cannot authorize handoff`, async t => {
    const f = await fixture(t);
    f.onPost = async () => { await f.receipt(mismatch); await rm(f.statePath); f.setOldAlive(false); };
    await assert.rejects(f.start());
    assert.equal(f.launches.length, 0);
    assert.equal(f.backend.owned, false);
  });
}

test("an old launcher without the handoff protocol is refused instead of pretending its false capabilities were upgraded", async t => {
  const f = await fixture(t, { unsupported: true, status: 404 });
  await assert.rejects(f.start(), /稳定|升级|协议|unsupported|handoff/i);
  assert.equal(f.launches.length, 0);
  assert.equal(f.backend.owned, false);
  assert.deepEqual(JSON.parse(await readFile(f.statePath, "utf8")), JSON.parse(JSON.stringify(f.initial)));
});

const recoveryRequestId = "a11610a4-3150-4f2e-a85f-715e7e1daa84";
async function recoveryIntent(f, { intent = {}, receipt = {}, oldAlive = false, missingReceipt = false } = {}) {
  const value = { protocol: 1, nonce: oldState.nonce, requestId: recoveryRequestId, pid: oldState.pid,
    version: oldState.version, url: oldState.url, phase: "requested", ...intent };
  await writeFile(join(f.root, "pi-web", "desktop-handoff.json"), JSON.stringify(value));
  if (!missingReceipt) await writeFile(f.handoffPath, JSON.stringify({ protocol: 1, nonce: oldState.nonce,
    requestId: recoveryRequestId, pid: oldState.pid, phase: "stopped", ...receipt }));
  await rm(f.statePath);
  f.setOldAlive(oldAlive);
  f.backend.state = undefined; f.backend.owned = false;
  return value;
}

test("reopening after an interrupted accepted handoff resumes only the exact stopped owner at its previous origin", async t => {
  const f = await fixture(t);
  await recoveryIntent(f);
  const result = await f.backend.connect();
  assert.equal(result.url, address);
  assert.equal(result.version, oldState.version);
  assert.equal(f.launches.length, 1);
  assert.equal(f.launches[0].options.env.PI_WEBAPP_RESTART_TOKEN, token);
  assert.equal(f.launches[0].options.env.PI_WEBAPP_RESTART_PORT, "12345");
  assert.equal(f.requests.some(request => request.url.endsWith("/api/desktop/handoff")), false, "recovery must not issue a second shutdown request");
  assert.equal(JSON.parse(await readFile(join(f.root, "pi-web", "desktop-handoff.json"), "utf8")).completed, true);
});

test("an interrupted handoff cannot start a replacement while its exact old PID remains alive", async t => {
  const f = await fixture(t);
  await recoveryIntent(f, { oldAlive: true });
  await assert.rejects(f.backend.connect());
  assert.equal(f.launches.length, 0);
  assert.equal(f.backend.owned, false);
});

test("interrupted handoff recovery does not mark completion when authenticated successor capabilities remain false", async t => {
  const f = await fixture(t, { successorCapabilities: true, successorWireCapabilities: false });
  const intent = await recoveryIntent(f);
  await assert.rejects(f.backend.connect(), /能力|capabilit|验证/i);
  assert.deepEqual(JSON.parse(await readFile(join(f.root, "pi-web", "desktop-handoff.json"), "utf8")), intent);
  assert.equal(JSON.parse(await readFile(f.statePath, "utf8")).nonce, "new-shell-owner", "failed recovery verification preserves the running service");
  await assert.rejects(readFile(join(f.root, "pi-web", "launcher.stop")), { code: "ENOENT" });
});

for (const invalid of [
  { label: "missing receipt", missingReceipt: true },
  { label: "still-draining receipt", receipt: { phase: "draining" } },
  { label: "failed receipt", receipt: { phase: "failed" } },
  { label: "stale request receipt", receipt: { requestId: "742cb948-fc76-4763-ac35-28b03daf7f1a" } },
  { label: "different selected version", intent: { version: "0.1.45" } },
]) test(`reopening preserves an interrupted handoff with ${invalid.label} instead of cold-starting over it`, async t => {
  const f = await fixture(t);
  const intent = await recoveryIntent(f, invalid);
  await assert.rejects(f.backend.connect());
  assert.equal(f.launches.length, 0);
  assert.equal(f.backend.owned, false);
  assert.deepEqual(JSON.parse(await readFile(join(f.root, "pi-web", "desktop-handoff.json"), "utf8")), intent);
});

for (const completed of [true, false]) test(`a ${completed ? "completed" : "cancelled"} native intent preserves the known origin on later ordinary startup`, async t => {
  const f = await fixture(t);
  await recoveryIntent(f, { intent: completed ? { completed: true } : { cancelled: true }, missingReceipt: true });
  const result = await f.backend.connect();
  assert.equal(result.url, address);
  assert.equal(f.launches.length, 1);
  assert.equal(f.launches[0].options.env.PI_WEBAPP_RESTART_PORT, "12345");
  assert.equal(f.launches[0].options.env.PI_WEBAPP_RESTART_TOKEN, token);
});
