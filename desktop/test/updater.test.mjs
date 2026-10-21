import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkDesktopRelease, compareDesktop, downloadDesktopAsset, repository, releasesUrl, validateManifest } from "../update-release.mjs";
import { assertDesktopInstallSafe, hasPublisherSignature, stageNativeUpdate } from "../update-native.mjs";
import { DesktopUpdater } from "../updater.mjs";

const bytes = Buffer.from("test update bytes");
const sha = value => createHash("sha256").update(value).digest("hex");
const asset = name => ({ name, bytes: bytes.length, sha256: sha(bytes) });
function fixtureManifest() {
  const manifest = { schemaVersion: 1, repository, version: "0.1.20", build: 7, tag: "desktop-v0.1.20-b7", productName: "pi",
    platform: "darwin", arch: "arm64", sourceCommit: "a".repeat(40), unsigned: false, prerelease: true,
    asset: asset("pi-0.1.20-desktop.7-mac-arm64.dmg"), updateAsset: asset("pi-0.1.20-desktop.7-mac-arm64.zip") };
  const release = { tag_name: manifest.tag, prerelease: true, draft: false, assets: [manifest.asset, manifest.updateAsset].map(item => ({ name: item.name,
    size: item.bytes, state: "uploaded", browser_download_url: `${releasesUrl}/download/${manifest.tag}/${item.name}` })).concat({ name: "desktop-release.json" }) };
  return { manifest, release };
}
async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-updater-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const json = value => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

test("desktop comparison includes build number, rejects prerelease/unsafe versions, never downgrades", () => {
  assert.equal(compareDesktop({ version: "0.1.20", build: 7 }, { version: "0.1.20", build: 6 }), 1);
  assert.equal(compareDesktop({ version: "0.1.19", build: 99 }, { version: "0.1.20", build: 6 }), -1);
  assert.equal(compareDesktop({ version: "0.1.20", build: 6 }, { version: "0.1.20", build: 6 }), 0);
  for (const version of ["latest", "01.1.20", "0.1.20-beta", "9007199254740992.1.1"]) assert.throws(() => compareDesktop({ version, build: 1 }, { version: "0.1.20", build: 1 }));
});

test("release discovery handles the explicit prerelease channel and skips drafts/npm tags", async () => {
  const { manifest, release } = fixtureManifest(); const calls = [];
  const fetchRequest = async (url, options) => {
    calls.push([url, options]);
    if (calls.length === 1) return json([{ ...release, draft: true, tag_name: "desktop-v9.0.0-b99" }, { tag_name: "v9.0.0" }, release]);
    return json(manifest);
  };
  const result = await checkDesktopRelease({ version: "0.1.20", build: 6 }, { arch: "arm64", fetchRequest });
  assert.equal(result.build, 7); assert.equal(calls.length, 2);
  assert.equal(calls[0][1].redirect, "error"); assert.equal(calls[1][1].redirect, "manual");
  assert.ok(Object.isFrozen(result));
  assert.equal(await checkDesktopRelease({ version: "0.1.21", build: 8 }, { arch: "arm64", fetchRequest: async () => json([release]) }), null);
  await assert.rejects(checkDesktopRelease({ version: "0.1.20", build: 1 }, { arch: "x64", fetchRequest }), /仅支持/);
});

test("manifest mismatches, traversal, wrong publisher/arch/asset and oversized updates fail closed", () => {
  for (const mutate of [m => m.repository = "attacker/repo", m => m.arch = "x64", m => m.platform = "linux", m => m.tag += "-extra",
    m => m.build = -1, m => m.asset.name = "../outside.dmg", m => m.updateAsset.name = "../outside.zip", m => m.asset.bytes = 3 * 1024 ** 3,
    m => m.asset.sha256 = "bad", m => m.prerelease = false, m => m.unsigned = "false", m => m.sourceCommit = "unknown"]) {
    const { manifest, release } = fixtureManifest(); mutate(manifest);
    assert.throws(() => validateManifest(manifest, release, "arm64"));
  }
  const { manifest, release } = fixtureManifest();
  release.assets[0].browser_download_url = "https://attacker.invalid/file";
  assert.throws(() => validateManifest(manifest, release, "arm64"));
});

test("release fetch rejects rate limits, oversized/malformed JSON and unsafe redirect destinations", async () => {
  const { release } = fixtureManifest();
  await assert.rejects(checkDesktopRelease({ version: "0.1.20", build: 1 }, { arch: "arm64", fetchRequest: async () => new Response("", { status: 403 }) }), /访问频率/);
  for (const response of [new Response("x".repeat(2 * 1024 ** 2 + 1)), json({})]) {
    await assert.rejects(checkDesktopRelease({ version: "0.1.20", build: 1 }, { arch: "arm64", fetchRequest: async () => response }));
  }
  let calls = 0;
  await assert.rejects(checkDesktopRelease({ version: "0.1.20", build: 1 }, { arch: "arm64", fetchRequest: async () => {
    if (++calls === 1) return json([release]);
    return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } });
  } }), /地址无效/);
  assert.equal(calls, 2, "no request is made to the redirected private address");
});

test("downloads are streamed, hash/size verified and safely follow only GitHub asset redirects", async t => {
  const root = await temporary(t); const { manifest } = fixtureManifest(); const target = join(root, "update.zip"); let calls = 0; let progress = 0;
  await downloadDesktopAsset(manifest, manifest.updateAsset, target, { fetchRequest: async (url, options) => {
    assert.equal(options.redirect, "manual"); assert.equal(options.headers.Authorization, undefined);
    if (++calls === 1) return new Response(null, { status: 302, headers: { location: "https://release-assets.githubusercontent.com/test?secret=never-log" } });
    return new Response(bytes, { headers: { "content-length": String(bytes.length) } });
  }, onProgress: value => progress = value });
  assert.deepEqual(await readFile(target), bytes); assert.equal(progress, 1); assert.equal(calls, 2);
  await assert.rejects(downloadDesktopAsset(manifest, manifest.updateAsset, target, { fetchRequest: async () => new Response(bytes) }), { code: "EEXIST" });
  assert.deepEqual(await readFile(target), bytes, "an existing file is never erased on an exclusive-create failure");
});

test("failed, corrupt, truncated, oversized and cancelled downloads leave no staged file", async t => {
  const root = await temporary(t); const { manifest } = fixtureManifest();
  for (const body of [Buffer.from("corrupted contents"), bytes.subarray(1), Buffer.concat([bytes, bytes])]) {
    const target = join(root, "bad.zip");
    await assert.rejects(downloadDesktopAsset(manifest, manifest.updateAsset, target, { fetchRequest: async () => new Response(body) }));
    await assert.rejects(readFile(target), { code: "ENOENT" });
  }
  const signal = AbortSignal.abort();
  await assert.rejects(downloadDesktopAsset(manifest, manifest.updateAsset, join(root, "cancelled.zip"), { signal, fetchRequest: async () => new Response(bytes) }));
  assert.deepEqual(await readdir(root), []);
});

test("live bundled/unknown/starting backends block install; npm state and task ownership are untouched", async () => {
  const stop = () => { throw new Error("must not stop a service"); };
  for (const state of [{ starting: true }, { pid: 42, nonce: "n", runtimeKind: "desktop" }, { pid: 42, nonce: "n" }]) {
    await assert.rejects(assertDesktopInstallSafe({ readState: async () => state, isAlive: () => true, stop }));
  }
  const state = { pid: 42, nonce: "n", runtimeKind: "npm", url: "local" };
  await assertDesktopInstallSafe({ readState: async () => state, isAlive: () => true, stop });
  await assertDesktopInstallSafe({ readState: async () => state, isAlive: () => false, owned: true, stop });
  await assertDesktopInstallSafe({ readState: async () => null, stop });
  await assert.rejects(assertDesktopInstallSafe({ readState: async () => state, isAlive: () => true, owned: true, stop }));
  let calls = 0;
  await assert.rejects(assertDesktopInstallSafe({ readState: async () => ++calls === 1 ? state : { ...state, nonce: "replacement" }, isAlive: () => true, stop }), /发生变化/);
});

test("ad-hoc, missing, or broken local code signatures never enable automatic installation", async () => {
  assert.equal(await hasPublisherSignature("/app", async () => { throw new Error("unsigned"); }), false);
  for (const stderr of ["TeamIdentifier=not set", "Signature=adhoc\nTeamIdentifier=ABCDEFGHIJ"]) {
    assert.equal(await hasPublisherSignature("/app", async () => ({ stderr })), false);
  }
  const calls = [];
  assert.equal(await hasPublisherSignature("/app", async (...args) => { calls.push(args); return { stderr: "TeamIdentifier=ABCDEFGHIJ\n" }; }), true);
  assert.ok(calls[0][1].includes("--strict"));
});

test("native staging serves a token-bound local feed of the verified ZIP and removes listeners", async t => {
  const root = await temporary(t); const zip = join(root, "update.zip"); await writeFile(zip, bytes);
  const { manifest } = fixtureManifest(); const native = new EventEmitter(); let feedUrl;
  native.setFeedURL = options => { feedUrl = options.url; assert.equal(options.serverType, "json"); };
  native.checkForUpdates = () => { void (async () => {
    try {
      assert.equal(new URL(feedUrl).hostname, "127.0.0.1");
      assert.equal((await fetch(new URL("/feed", feedUrl))).status, 404);
      assert.equal((await fetch(feedUrl, { method: "POST" })).status, 404);
      const feed = await (await fetch(feedUrl)).json();
      assert.deepEqual(Buffer.from(await (await fetch(feed.url)).arrayBuffer()), bytes);
      native.emit("update-downloaded");
    } catch (error) { native.emit("error", error); }
  })(); };
  await stageNativeUpdate(native, manifest, zip);
  assert.equal(native.listenerCount("error"), 0); assert.equal(native.listenerCount("update-downloaded"), 0);
  await assert.rejects(fetch(feedUrl), "private feed must close after staging");
});

test("native failures and timeouts do not become ready updates or leak feed URLs", async t => {
  const root = await temporary(t); const zip = join(root, "update.zip"); await writeFile(zip, bytes); const { manifest } = fixtureManifest();
  for (const mode of ["error", "timeout", "unavailable"]) {
    const native = new EventEmitter(); native.setFeedURL = () => {};
    native.checkForUpdates = () => { if (mode === "error") native.emit("error", new Error("http://secret-feed")); if (mode === "unavailable") native.emit("update-not-available"); };
    await assert.rejects(stageNativeUpdate(native, manifest, zip, { timeoutMs: 10 }), error => !error.message.includes("secret-feed"));
    assert.equal(native.listenerCount("error"), 0);
  }
});

async function controllerFixture(t, changes = {}) {
  const root = await temporary(t); const { manifest } = fixtureManifest(); const dialogs = []; const opened = []; let staged = 0; let installed = 0; let before = 0;
  const native = new EventEmitter(); native.quitAndInstall = () => installed++;
  const updater = new DesktopUpdater({ current: { version: "0.1.20", build: 6 }, platform: "darwin", arch: "arm64", packaged: true,
    appPath: "/Applications/pi.app", cachePath: root, autoUpdater: native,
    showMessageBox: async options => { dialogs.push(options); return { response: options.buttons.length > 1 ? 1 : 0 }; },
    openExternal: async url => opened.push(url), revealFile: path => opened.push(path), getBackend: () => null, beforeInstall: () => before++,
    check: async () => manifest, signed: async () => true, stage: async () => staged++,
    download: async (_manifest, _asset, path) => writeFile(path, bytes), ...changes });
  return { updater, root, manifest, dialogs, opened, staged: () => staged, installed: () => installed, before: () => before };
}

test("signed updates require a download consent and a separate install consent before quitting", async t => {
  const f = await controllerFixture(t); await f.updater.run();
  assert.equal(f.dialogs[0].buttons[1], "下载并校验"); assert.equal(f.dialogs[1].buttons[1], "安装并重启");
  assert.equal(f.staged(), 1); assert.equal(f.installed(), 1); assert.equal(f.before(), 1); assert.deepEqual(await readdir(f.root), []);
});

test("unsigned releases/current app fall back to checked DMG, never native staging or installation", async t => {
  for (const currentUnsigned of [true, false]) {
    const { manifest } = fixtureManifest(); manifest.unsigned = !currentUnsigned;
    const f = await controllerFixture(t, { check: async () => manifest, signed: async () => !currentUnsigned });
    await f.updater.run();
    assert.equal(f.dialogs[0].buttons[1], "下载校验 DMG（手动安装）");
    assert.equal(f.staged(), 0); assert.equal(f.installed(), 0);
    assert.equal(f.opened.length, 1); assert.match(f.opened[0], /\.dmg$/); assert.deepEqual(await readFile(f.opened[0]), bytes);
  }
});

test("cancellation, install postponement, backend protection and native failure never quit/stop tasks", async t => {
  const cancelled = await controllerFixture(t, { showMessageBox: async () => ({ response: 0 }) });
  await cancelled.updater.run(); assert.equal(cancelled.staged(), 0); assert.equal(cancelled.installed(), 0);
  const delayed = await controllerFixture(t, { showMessageBox: async options => ({ response: options.title === "安装桌面更新" ? 0 : 1 }) });
  await delayed.updater.run(); assert.equal(delayed.staged(), 0); assert.equal(delayed.installed(), 0); assert.ok(delayed.updater.ready);
  let alive = true; const state = { pid: 42, nonce: "n", runtimeKind: "desktop" };
  const protectedUpdate = await controllerFixture(t, { getBackend: () => ({ readState: async () => state, isAlive: () => alive, stop: () => assert.fail("never stop") }) });
  await protectedUpdate.updater.run(); assert.equal(protectedUpdate.staged(), 0); assert.equal(protectedUpdate.installed(), 0); assert.ok(protectedUpdate.updater.ready);
  alive = false; await protectedUpdate.updater.run(); assert.equal(protectedUpdate.installed(), 1); assert.equal(protectedUpdate.staged(), 1);
  alive = true; await assert.rejects(protectedUpdate.updater.assertQuitSafe(), /内置后台仍在运行/);
  const failed = await controllerFixture(t, { stage: async () => { throw new Error("signature failed"); } });
  await failed.updater.run(); assert.equal(failed.installed(), 0); assert.equal(failed.updater.ready, null); assert.deepEqual(await readdir(failed.root), []);
});

test("backend replacement during native staging blocks both install and a later ordinary quit", async t => {
  let state = { pid: 42, nonce: "npm", runtimeKind: "npm" };
  const f = await controllerFixture(t, {
    getBackend: () => ({ readState: async () => state, isAlive: () => true }),
    stage: async () => { state = { pid: 43, nonce: "replacement", runtimeKind: "desktop" }; },
  });
  await f.updater.run();
  assert.equal(f.installed(), 0); assert.equal(f.updater.nativeReady, true);
  await assert.rejects(f.updater.assertQuitSafe(), /内置后台仍在运行/);
});

test("download cancellation aborts only the download and cleans partial files", async t => {
  let downloaded;
  const started = new Promise(resolve => downloaded = resolve);
  const f = await controllerFixture(t, { download: async (_manifest, _asset, path, { signal }) => {
    await writeFile(path, "partial"); downloaded();
    await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  } });
  const run = f.updater.run(); await started; f.updater.cancelDownload(); await run;
  assert.equal(f.installed(), 0); assert.equal(f.staged(), 0); assert.deepEqual(await readdir(f.root), []);
});

test("errors after accepting a background update are visible rather than silently discarded", async t => {
  const f = await controllerFixture(t, { stage: async () => { throw new Error("rejected signature"); } });
  await f.updater.run({ silent: true });
  assert.equal(f.dialogs.at(-1).title, "桌面更新未安装"); assert.equal(f.installed(), 0);
});

test("background check failures are quiet, unsupported environments link Releases and concurrent checks coalesce", async t => {
  const quiet = await controllerFixture(t, { check: async () => { throw new Error("offline"); } });
  await quiet.updater.run({ silent: true }); assert.equal(quiet.dialogs.length, 0);
  const unsupported = await controllerFixture(t, { platform: "linux" }); await unsupported.updater.run(); assert.deepEqual(unsupported.opened, [releasesUrl]);
  let releaseCheck; let calls = 0;
  const concurrent = await controllerFixture(t, { check: () => { calls++; return new Promise(resolve => releaseCheck = resolve); } });
  const first = concurrent.updater.run(); await concurrent.updater.run(); releaseCheck(null); await first; assert.equal(calls, 1);
});
