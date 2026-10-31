import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { DesktopBackend, alive } from "../backend.mjs";
import { desktopUpdatePath, readDesktopRelease, rollbackDesktopRelease, writeDesktopRelease } from "../managed-release.mjs";
import { fakePi, stageRuntime } from "./fixtures/runtime.mjs";

const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
const launcher = fileURLToPath(new URL("../../bin/pi-webapp.mjs", import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-package-update 中文 "));
  const piCli = join(root, "fake-pi.mjs");
  await writeFile(piCli, fakePi);
  const backend = new DesktopBackend({ agentDir: root, version: pkg.version, node: process.execPath, piCli,
    launcher, npmCli: "unused", cwd: root, isAlive: alive,
    env: { ...process.env, PI_CODING_AGENT_DIR: root, PI_WEBAPP_RESTART_PORT: undefined, PI_WEBAPP_RESTART_TOKEN: undefined, PI_WEB_SENTRY_ENABLED: "false" }, timeoutMs: 10000 });
  t.after(async () => { await backend.stop(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return backend;
}

async function successor(backend, first, version) {
  for (let i = 0; i < 150; i++) {
    const next = await backend.readState();
    if (next?.url && next.nonce !== first.nonce && next.version === version) return next;
    await delay(50);
  }
  assert.fail(`supervised desktop restart did not become ready: ${await readFile(backend.logPath, "utf8")}`);
}

test("cross-version attachment requires authenticated shell protocol agreement", async t => {
  const backend = await fixture(t);
  const state = { url: `http://127.0.0.1:12345/#${"a".repeat(32)}`, version: "9.0.0", bridgeVersion: 1, desktopProtocolVersion: 1 };
  backend.fetchRequest = async () => ({ ok: true, json: async () => ({ current: "9.0.0", desktopProtocolVersion: 1 }) });
  assert.deepEqual(await backend.validate(state), state);
  await assert.rejects(backend.validate({ ...state, desktopProtocolVersion: 2 }), /版本组合/);
  await assert.rejects(backend.validate({ ...state, version: "8.0.0" }), /版本组合/);
  backend.fetchRequest = async () => ({ ok: true, json: async () => ({ current: "9.0.0" }) });
  await assert.rejects(backend.validate(state), /版本组合/);
});

test("desktop reopens a selected user package without modifying or launching the bundled package", async t => {
  const backend = await fixture(t);
  const release = await stageRuntime(backend.agentDir, "9.0.0");
  await writeDesktopRelease(backend.agentDir, release);
  const started = await backend.connect();
  assert.equal(started.version, release.version);
  assert.equal(backend.owned, true);
  assert.equal(backend.piCli, await realpath(release.piCli));
  const shared = new DesktopBackend({ ...backend, version: pkg.version, spawnProcess: () => assert.fail("must reuse service") });
  assert.equal((await shared.connect()).pid, started.pid);
  assert.equal(shared.owned, false);
});

for (const version of ["9.0.0-alpha.10", "0.1.26"]) {
  test(`desktop cold launch retains selected channel version ${version}`, async t => {
    const backend = await fixture(t);
    const release = await stageRuntime(backend.agentDir, version);
    await writeDesktopRelease(backend.agentDir, { ...release, fallbackVersion: pkg.version });
    assert.equal((await backend.connect()).version, version);
    assert.equal(backend.owned, true);
  });
}

test("desktop package restart keeps the URL and adopts only its authenticated successor", async t => {
  const backend = await fixture(t);
  const first = await backend.connect();
  const release = await stageRuntime(backend.agentDir, "9.0.0");
  await writeDesktopRelease(backend.agentDir, release);
  await writeFile(join(backend.agentDir, "pi-web", "launcher.restart"), JSON.stringify({ nonce: first.nonce, launcher: release.launcher }));
  const next = await successor(backend, first, release.version);
  assert.equal(next.url, first.url);
  await backend.refresh();
  assert.equal(backend.state.nonce, next.nonce);
  assert.equal(backend.owned, true);
  await backend.stop();
  assert.equal(await backend.readState(), null);
});

test("failed desktop update restarts the previous service and restores its persistent selection", async t => {
  const backend = await fixture(t);
  const previous = await stageRuntime(backend.agentDir, "9.0.0");
  await writeDesktopRelease(backend.agentDir, previous);
  const first = await backend.connect();
  const broken = await stageRuntime(backend.agentDir, "9.1.0", { broken: true });
  await writeDesktopRelease(backend.agentDir, { ...broken, previous });
  await writeFile(join(backend.agentDir, "pi-web", "launcher.restart"), JSON.stringify({ nonce: first.nonce, launcher: broken.launcher }));
  const recovered = await successor(backend, first, previous.version);
  assert.equal(recovered.url, first.url);
  assert.equal((await readDesktopRelease(backend.agentDir, pkg.version)).launcher, previous.launcher);
});

test("a broken saved user package falls back to the bundled runtime on desktop launch", async t => {
  const backend = await fixture(t);
  const broken = await stageRuntime(backend.agentDir, "9.0.0", { broken: true });
  await writeDesktopRelease(backend.agentDir, broken);
  assert.equal((await backend.connect()).version, pkg.version);
  assert.equal(await readDesktopRelease(backend.agentDir, pkg.version), null);
});

test("invalid, older, external and mismatched selections never replace the bundled fallback", async t => {
  const backend = await fixture(t);
  const release = await stageRuntime(backend.agentDir, "9.0.0");
  for (const bad of [{ ...release, version: "9.1.0" }, { ...release, desktopProtocolVersion: 2 },
    { ...release, launcher }, { ...release, launcher: join(backend.agentDir, "../arbitrary.mjs") }]) {
    await writeDesktopRelease(backend.agentDir, bad);
    assert.equal(await readDesktopRelease(backend.agentDir, pkg.version), null);
  }
  await writeDesktopRelease(backend.agentDir, release);
  assert.equal(await readDesktopRelease(backend.agentDir, "10.0.0"), null);
  await rollbackDesktopRelease(backend.agentDir, "not-the-selected-launcher");
  assert.ok(await readFile(desktopUpdatePath(backend.agentDir)));
});
