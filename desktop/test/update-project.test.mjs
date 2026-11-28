import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ProjectDesktopUpdate } from "../update-project.mjs";
import { checkDesktopRelease, downloadDesktopAsset, projectSignatureName, releasesUrl, repository } from "../update-release.mjs";

const execute = promisify(execFile);
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const key = publicKey.export({ type: "spki", format: "pem" });
const current = { version: "1.0.0", build: 1 };
const next = { version: "1.0.0", build: 2 };
const cleanBackend = { readState: async () => null };

function feed(payload, { mode, version = next.version, build = next.build, unsigned = true } = {}) {
  const tag = `desktop-v${version}-b${build}`;
  const asset = { name: `pi-${version}-desktop.${build}-mac-arm64.dmg`, bytes: payload.length,
    sha256: createHash("sha256").update(payload).digest("hex") };
  const manifest = { schemaVersion: 1, repository, productName: "pi", version, build, tag, unsigned,
    platform: "darwin", arch: "arm64", sourceCommit: "a".repeat(40), prerelease: true, asset };
  const tagRoot = `${releasesUrl}/download/${tag}/`;
  const bytes = Buffer.from(JSON.stringify(manifest));
  const signature = sign(null, bytes, privateKey);
  const remote = (name, size) => ({ name, size, state: "uploaded", browser_download_url: `${tagRoot}${name}` });
  const assets = [remote(asset.name, asset.bytes), remote("desktop-release.json", bytes.length)];
  if (mode !== "missing") assets.push(remote(projectSignatureName, 64));
  const release = { tag_name: tag, draft: false, prerelease: true, assets };
  const calls = [];
  return { calls, manifest, fetchRequest: async url => {
    calls.push(url);
    if (url.startsWith("https://api.github.com/")) return Response.json([release]);
    if (url === tagRoot + "desktop-release.json") return new Response(mode === "manifest" ? Buffer.concat([bytes, Buffer.from(" ")]) : bytes);
    if (url === tagRoot + projectSignatureName) return new Response(mode === "signature" ? Buffer.alloc(64) : signature);
    if (url === tagRoot + asset.name) return new Response(mode === "dmg" ? Buffer.alloc(payload.length) : payload);
    throw new Error("Unexpected URL");
  } };
}

async function temporary(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-project-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const discover = fixture => checkDesktopRelease(current, { arch: "arm64", projectKey: key, fetchRequest: fixture.fetchRequest });

test("project channel requires the pinned signing key, exact manifest bytes, an ad-hoc target and no downgrade", async t => {
  const valid = feed(Buffer.from("installer"));
  assert.deepEqual((await discover(valid)).asset, valid.manifest.asset);
  for (const mode of ["manifest", "signature"]) {
    const broken = feed(Buffer.from("installer"), { mode });
    await assert.rejects(discover(broken), /Invalid project release signature/);
    assert.equal(broken.calls.length, 3);
  }
  const wrong = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });
  await assert.rejects(checkDesktopRelease(current, { arch: "arm64", projectKey: wrong, fetchRequest: valid.fetchRequest }), /Invalid project release signature/);
  for (const options of [{ mode: "missing" }, { build: 1 }, { unsigned: false }]) {
    assert.equal(await discover(feed(Buffer.from("installer"), options)), null);
  }

  const damaged = feed(Buffer.from("installer"), { mode: "dmg" });
  const manifest = await discover(damaged);
  const out = join(await temporary(t), "update.dmg");
  await assert.rejects(downloadDesktopAsset(manifest, manifest.asset, out, { fetchRequest: damaged.fetchRequest }));
  await assert.rejects(readFile(out), { code: "ENOENT" });
});

test("project updates default off; explicit opt-in persists and live bundled service defers safe quit", async t => {
  const root = await temporary(t);
  const transaction = await mkdtemp(join(root, ".pi-update-"));
  const fixture = feed(Buffer.from("installer"));
  let response = 0;
  const controller = new ProjectDesktopUpdate({ current, key, packaged: true, platform: "darwin", arch: "arm64", home: root,
    appPath: join(root, "Applications", "pi.app"), profile: root, cachePath: root, helperPath: process.execPath,
    showMessageBox: async () => ({ response }), check: () => discover(fixture),
    download: (manifest, asset, target, options) => downloadDesktopAsset(manifest, asset, target, { ...options, fetchRequest: fixture.fetchRequest }),
    stage: async () => ({ transaction, old: ["0", "1"], next: ["0", "2"] }),
    getBackend: () => ({ owned: true, readState: async () => ({ pid: 123, nonce: "nonce", runtimeKind: "desktop" }), isAlive: () => true }),
    launch: () => assert.fail("must not touch live bundled service") });
  if (process.getuid?.() === 0 || !process.getuid) controller.available = true; // mock config only; real helper still refuses root
  await controller.run();
  assert.equal(fixture.calls.length, 0);
  await controller.setEnabled(true);
  assert.equal(controller.enabled, false);
  response = 1;
  await controller.setEnabled(true);
  assert.equal(await readFile(controller.optInPath, "utf8"), "enabled\n");
  await controller.run();
  assert.equal(controller.pending.transaction, transaction);
  await controller.prepareQuit();
  controller.commitQuit();
  assert.equal(controller.pending, null);
  await assert.rejects(readFile(join(transaction, "update-swap")), { code: "ENOENT" });
});

const realDarwin = process.platform === "darwin" && process.arch === "arm64" && process.getuid() !== 0;

test("real macOS arm64 DMG: project signature → ad-hoc staging → quarantine → atomic swap and rollback copy", { skip: !realDarwin, timeout: 45000 }, async t => {
  const root = await temporary(t);
  const applications = join(root, "Applications");
  const image = join(root, "image");
  const installed = join(applications, "pi.app");
  async function makeApp(appPath, build) {
    const contents = join(appPath, "Contents");
    await mkdir(join(contents, "MacOS"), { recursive: true });
    const fields = { CFBundleIdentifier: "dev.pi.webapp", CFBundleExecutable: "pi", CFBundleName: "pi",
      CFBundlePackageType: "APPL", CFBundleShortVersionString: next.version, CFBundleVersion: `${build}.0.0` };
    await writeFile(join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>${Object.entries(fields)
      .map(([k, v]) => `<key>${k}</key><string>${v}</string>`).join("")}</dict></plist>`);
    execFileSync("/usr/bin/clang", ["-arch", "arm64", "-x", "c", "-", "-o", join(contents, "MacOS", "pi")], { input: `int main(void) { return ${build}; }` });
    await execute("/usr/bin/codesign", ["--force", "--sign", "-", appPath]);
  }
  await makeApp(installed, current.build);
  await makeApp(join(image, "pi.app"), next.build);
  const dmg = join(root, "payload.dmg");
  await execute("/usr/bin/hdiutil", ["create", "-format", "UDZO", "-srcfolder", image, dmg]);
  const helper = join(root, "helper");
  await execute("/usr/bin/clang", ["-arch", "arm64", "-Wall", "-Wextra", "-Werror", "-o", helper, fileURLToPath(new URL("../update-swap.c", import.meta.url))]);
  const { fetchRequest } = feed(await readFile(dmg));
  const profile = join(root, "profile");
  await mkdir(profile);
  const options = { current, packaged: true, home: root, appPath: installed, profile, cachePath: root, helperPath: helper,
    getBackend: () => cleanBackend, showMessageBox: async () => ({ response: 1 }), key,
    check: (identity, opts) => checkDesktopRelease(identity, { ...opts, fetchRequest }),
    download: (manifest, asset, out, opts) => downloadDesktopAsset(manifest, asset, out, { ...opts, fetchRequest }) };
  const controller = new ProjectDesktopUpdate(options);
  await controller.initialize();
  assert.equal(controller.available, true);
  await controller.setEnabled(true);
  await controller.run();
  assert.ok(controller.pending, "the verified DMG must produce a staged app");
  const { transaction } = controller.pending;
  const staged = join(transaction, "pi.app");
  const buildOf = async location => (await execute("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleVersion", join(location, "Contents", "Info.plist")])).stdout.trim();
  assert.equal(await buildOf(installed), "1.0.0");
  assert.equal(await buildOf(staged), "2.0.0");
  const quarantine = async location => (await execute("/usr/bin/xattr", ["-p", "com.apple.quarantine", location])).stdout;
  const originalQuarantine = await quarantine(staged);
  assert.match(originalQuarantine, /^0081;/);

  // Production commit uses a detached helper from a real process after
  // will-quit; this fixture process stands in for the quitting Electron main.
  await controller.prepareQuit();
  assert.ok(controller.armed);
  const parentScript = `
    import {launchProjectSwap} from ${JSON.stringify(new URL("../update-project.mjs", import.meta.url).href)};
    launchProjectSwap(process.argv[1], process.argv[2], JSON.parse(process.argv[3]));
    process.stdin.resume();`;
  const parent = spawn(process.execPath, ["--input-type=module", "-e", parentScript, controller.armed.helper, installed, JSON.stringify(controller.armed.pending)],
    { stdio: ["pipe", "ignore", "inherit"] });
  const exited = once(parent, "exit");
  t.after(() => { parent.stdin.end(); return exited; });
  const receipt = join(transaction, "result");
  async function until(read) {
    for (let i = 0; i < 200; i += 1) {
      const result = await read();
      if (result !== undefined) return result;
      await delay(30);
    }
    assert.fail("macOS helper did not report completion");
  }
  await until(() => readFile(receipt, "utf8").catch(() => undefined));
  assert.equal(await buildOf(installed), "1.0.0");
  parent.stdin.end();
  assert.deepEqual(await exited, [0, null]);
  assert.equal(await until(async () => (await readFile(receipt, "utf8")) || undefined), "installed\n");
  assert.equal(await buildOf(installed), "2.0.0");
  assert.equal(await quarantine(installed), originalQuarantine);
  assert.equal(await buildOf(staged), "1.0.0");
  await execute("/usr/bin/codesign", ["--verify", "--deep", "--strict", installed]);
  const reopened = new ProjectDesktopUpdate({ ...options, current: next });
  await reopened.initialize();
  assert.equal(reopened.enabled, true);
  assert.equal(reopened.previous, staged);
  await reopened.setEnabled(false);
  assert.equal(reopened.enabled, false);
  assert.equal(await buildOf(staged), "1.0.0");
});
