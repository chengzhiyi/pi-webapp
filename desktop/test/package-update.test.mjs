import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
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

for (const accepted of [true, false]) test(`a running preview supervisor ${accepted ? "accepts a stable restart bound to its shell baseline" : "rejects a stable restart bound to a different shell fallback"}`, async t => {
  const backend = await fixture(t);
  const shellVersion = "0.1.39";
  backend.version = shellVersion;
  backend.bundled.version = shellVersion;
  backend.env.PI_WEBAPP_DESKTOP_VERSION = shellVersion;
  backend.env.PI_WEBAPP_DESKTOP_BUILD = "12";
  const preview = await stageRuntime(backend.agentDir, "0.1.48-alpha.1");
  await writeDesktopRelease(backend.agentDir, preview);
  const first = await backend.connect();
  assert.equal(first.version, preview.version);
  const stable = await stageRuntime(backend.agentDir, "0.1.47");
  await writeDesktopRelease(backend.agentDir, { ...stable, fallbackVersion: accepted ? shellVersion : "0.1.28", previous: preview });
  const markerPath = join(backend.agentDir, "pi-web", "launcher.restart");
  const marker = JSON.stringify({ nonce: first.nonce, launcher: stable.launcher });
  await writeFile(markerPath, marker);
  if (!accepted) {
    // The supervisor checks markers every 400ms. Cover multiple admission passes
    // without starting a second owner or treating a wrong fallback as consent.
    await delay(1100);
    const current = await backend.readState();
    assert.equal(current.nonce, first.nonce);
    assert.equal(current.version, preview.version);
    assert.equal(alive(first.pid), true);
    assert.equal(await readFile(markerPath, "utf8"), marker);
    await backend.stop(); // Explicit recovery, never manually remove the request.
    for (let attempt = 0; alive(first.pid) && attempt < 100; attempt++) await delay(20);
    assert.equal(alive(first.pid), false);
    const history = join(backend.agentDir, "pi-web", "restart-history");
    await assert.rejects(readFile(markerPath), { code: "ENOENT" }, "a successful explicit stop must retire its obsolete request before releasing ownership");
    const names = (await readdir(history)).filter(name => name.startsWith(`${first.nonce}-`) && name.endsWith(".json"));
    assert.equal(names.length, 1);
    assert.equal(await readFile(join(history, names[0]), "utf8"), marker, "archiving preserves the original request bytes");
    const exit = (await readFile(backend.logPath, "utf8")).split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line))
      .find(record => record.event === "pi_process_exit" && record.pid === first.pid);
    assert.equal(exit.reason, "stop_request"); assert.equal(exit.exitCode, 0); assert.equal(exit.forceStopRequested, false);
    await writeFile(markerPath, JSON.stringify({ nonce: "a-later-owner", launcher: stable.launcher }), { flag: "wx" });
    return;
  }
  let next;
  for (let attempt = 0; attempt < 80; attempt++) {
    const current = await backend.readState();
    if (current?.url && current.nonce !== first.nonce && current.version === stable.version) { next = current; break; }
    await delay(50);
  }
  assert.ok(next, "a verified stable selection above the shell baseline must be consumed by the running preview supervisor");
  assert.equal(next.url, first.url, "channel switching preserves the existing browser origin and bearer token");
  for (let attempt = 0; alive(first.pid) && attempt < 100; attempt++) await delay(20);
  assert.equal(alive(first.pid), false, "the old supervisor must exit after handing off the same browser address");
  await backend.refresh();
  assert.equal(backend.state.nonce, next.nonce);
  assert.equal(backend.owned, true);
  await assert.rejects(readFile(markerPath), { code: "ENOENT" });
});

for (const outcome of ["other-owner", "nonzero", "forced-zero"]) test(`explicit stop preserves an obsolete restart marker for ${outcome}`, async t => {
  const backend = await fixture(t);
  if (outcome === "nonzero") {
    await writeFile(backend.piCli, fakePi.replace("server.close(() => process.exit(0))", "server.close(() => process.exit(7))"));
  } else if (outcome === "forced-zero") {
    await writeFile(backend.piCli, fakePi.replace('process.stdin.on(\'end\', () => server.close(() => process.exit(0)));',
      "process.stdin.on('end', () => {}); process.on('SIGTERM', () => server.close(() => process.exit(0)));"));
  }
  const first = await backend.connect();
  const markerPath = join(backend.agentDir, "pi-web", "launcher.restart");
  const marker = JSON.stringify({ nonce: outcome === "other-owner" ? "a-different-owner" : first.nonce, launcher: join(backend.agentDir, "unselected-candidate.mjs") });
  await writeFile(markerPath, marker);
  await backend.stop();
  for (let attempt = 0; alive(first.pid) && attempt < 100; attempt++) await delay(20);
  assert.equal(alive(first.pid), false);
  assert.equal(await readFile(markerPath, "utf8"), marker);
  const names = await readdir(join(backend.agentDir, "pi-web", "restart-history")).catch(error => { if (error.code === "ENOENT") return []; throw error; });
  assert.equal(names.some(name => name.startsWith(`${first.nonce}-`)), false);
  const exit = (await readFile(backend.logPath, "utf8")).split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line))
    .find(record => record.event === "pi_process_exit" && record.pid === first.pid);
  if (outcome === "nonzero") assert.equal(exit.exitCode, 7);
  if (outcome === "forced-zero") {
    assert.equal(exit.exitCode, 0);
    assert.equal(exit.forceStopRequested, true, "a forced SIGTERM handled as exit(0) is still not a natural stop receipt");
  }
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
