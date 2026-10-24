import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { compareVersions, parseVersion } from "../desktop/release-version.mjs";
import { SelfUpdater } from "../src/host/server/updates/self-update.ts";
import { readDesktopRelease } from "../desktop/managed-release.mjs";

async function fixture(t: test.TestContext, { current = "0.1.29", dataVersion = 1, desktop = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-channel 中文 "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = join(root, "source"); const agentDir = join(root, "agent");
  await mkdir(packageRoot);
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "pi-webapp", version: current, piWebappDataVersion: dataVersion }));
  let tags: { latest: string; alpha?: string } = { latest: "0.1.29", alpha: "0.2.0-alpha.2" };
  let installedDataVersion = dataVersion;
  const calls: string[][] = [];
  const options = { packageRoot, agentDir, launcherNonce: "owner", desktopManaged: desktop, desktopPackageUpdates: desktop, desktopReleaseChannels: desktop,
    peerSpecs: async () => [], verifyPackage: async () => {},
    runNpm: async (args: string[]) => {
      calls.push(args);
      if (args[0] === "view") return JSON.stringify(args[2] === "dist-tags" ? [tags] : tags.latest);
      const version = args[1]!.slice("pi-webapp@".length);
      const prefix = args[args.indexOf("--prefix") + 1]!;
      const installed = join(prefix, "node_modules", "pi-webapp");
      for (const file of ["bin/pi-webapp.mjs", "dist/extension.js", "web/dist/index.html"]) {
        await mkdir(dirname(join(installed, file)), { recursive: true });
        await writeFile(join(installed, file), "");
      }
      await writeFile(join(installed, "package.json"), JSON.stringify({ name: "pi-webapp", version, piWebappDataVersion: installedDataVersion, piWebappDesktopProtocol: 1 }));
      const pi = join(prefix, "node_modules", "@earendil-works", "pi-coding-agent");
      await mkdir(join(pi, "dist", "bundle"), { recursive: true });
      await writeFile(join(pi, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent" }));
      await writeFile(join(pi, "dist", "bundle", "cli.js"), "");
      return "";
    } };
  return { options, updater: new SelfUpdater(options), calls, agentDir,
    setTags(value: { latest: string; alpha?: string }) { tags = value; },
    setDataVersion(value: number) { installedDataVersion = value; } };
}

test("SemVer prerelease ordering is strict, numeric, ASCII and independent of build metadata", () => {
  const ordered = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.2", "1.0.0-alpha.10", "1.0.0-beta.1", "1.0.0", "1.0.1-alpha.1"];
  for (let i = 1; i < ordered.length; i++) assert.ok(compareVersions(ordered[i]!, ordered[i - 1]!) > 0);
  assert.ok(compareVersions("1.0.0-1", "1.0.0-a") < 0);
  assert.equal(compareVersions("1.0.0+build.2", "1.0.0+build.1"), 0);
  for (const value of ["01.0.0", "1.0.0-alpha.01", "1.0.0-", "1.0.0-a..1", "latest", "1.0.0\n", null]) assert.throws(() => parseVersion(value));
});

test("stable is the persisted default; alpha preference survives a new updater and never changes latest", async t => {
  const f = await fixture(t);
  assert.equal((await f.updater.check()).channel, "stable");
  assert.equal((await f.updater.check()).latest, "0.1.29");
  await f.updater.setChannel("alpha");
  const reopened = new SelfUpdater(f.options);
  const status = await reopened.check();
  assert.equal(status.channel, "alpha"); assert.equal(status.latest, "0.2.0-alpha.2");
  assert.equal(status.available, true);
  assert.deepEqual(JSON.parse(await readFile(join(f.agentDir, "pi-web", "update-preferences.json"), "utf8")), { channel: "alpha" });
  await assert.rejects(f.updater.setChannel("beta" as "stable"), /通道无效/);
  const prepared = await reopened.prepare({ channel: "alpha", version: "0.2.0-alpha.2" });
  assert.equal(prepared.version, "0.2.0-alpha.2");
  assert.ok(f.calls.some(args => args[1] === "pi-webapp@0.2.0-alpha.2"));
  await assert.rejects(reopened.setChannel("stable"), /正在进行中/);
});

test("preview prefers a newer stable release and tolerates an absent alpha tag", async t => {
  const f = await fixture(t);
  await f.updater.setChannel("alpha");
  for (const tags of [{ latest: "0.2.0", alpha: "0.2.0-alpha.10" }, { latest: "0.2.0" }]) {
    f.setTags(tags);
    assert.equal((await f.updater.check()).latest, "0.2.0");
  }
  f.setTags({ latest: "0.2.0", alpha: "garbage" });
  await assert.rejects(f.updater.check(), /alpha 版本号无效/);
  await f.updater.setChannel("stable");
  f.setTags({ latest: "0.2.0-alpha.1" });
  await assert.rejects(f.updater.check(), /版本号无效/);
});

test("a moved tag or changed preference cannot install a different target than confirmed", async t => {
  const f = await fixture(t);
  await f.updater.setChannel("alpha");
  const checked = await f.updater.check();
  f.setTags({ latest: "0.1.29", alpha: "0.2.0-alpha.3" });
  await assert.rejects(f.updater.prepare({ channel: "alpha", version: checked.latest! }), /目标或偏好已变化/);
  await f.updater.setChannel("stable");
  await assert.rejects(f.updater.prepare({ channel: "alpha", version: "0.2.0-alpha.3" }), /目标或偏好已变化/);
  assert.equal(f.calls.filter(args => args[0] === "install").length, 0);
});

for (const desktop of [false, true]) {
  test(`explicit stable downgrade checks data compatibility and persists selection (desktop=${desktop})`, async t => {
    const f = await fixture(t, { current: "0.2.0-alpha.3", desktop });
    const status = await f.updater.check();
    assert.equal(status.downgrade, true); assert.equal(status.available, true);
    await assert.rejects(f.updater.prepare(), /明确确认/);
    await assert.rejects(f.updater.prepare({ channel: "stable", version: "0.1.29" }), /明确确认/);
    const request = { channel: "stable" as const, version: "0.1.29", allowDowngrade: true };
    f.setDataVersion(2);
    await assert.rejects(f.updater.prepare(request), /数据格式不兼容/);
    assert.deepEqual(await readdir(join(f.agentDir, "pi-web", "releases")), []);
    f.setDataVersion(1);
    const prepared = await f.updater.prepare(request);
    const selection = JSON.parse(await readFile(join(f.agentDir, "pi-web", desktop ? "desktop-update.json" : "update.json"), "utf8"));
    assert.equal(selection.version, "0.1.29"); assert.equal(selection.launcher, prepared.launcher);
    if (desktop) {
      assert.equal((await readDesktopRelease(f.agentDir, "0.2.0-alpha.3"))?.version, "0.1.29");
      assert.equal(await readDesktopRelease(f.agentDir, "0.3.0"), null, "a newer shell must not inherit an older shell's downgrade override");
    } else {
      assert.equal(selection.allowDowngrade, true); assert.equal(selection.baseVersion, "0.2.0-alpha.3");
    }
  });
}

test("old desktop shells cannot select alpha packages they cannot retain on the next launch", async t => {
  const f = await fixture(t, { desktop: true });
  const oldShell = new SelfUpdater({ ...f.options, desktopReleaseChannels: false });
  await oldShell.setChannel("alpha");
  const status = await oldShell.check();
  assert.equal(status.canRestart, false); assert.equal(status.available, false);
  assert.match(status.reason ?? "", /先安装.*新版桌面/);
  await assert.rejects(oldShell.prepare(), /新版桌面/);
  assert.equal(f.calls.length, 0);
});

test("preview never offers a downgrade to an older alpha", async t => {
  const f = await fixture(t, { current: "0.2.0-alpha.3" });
  await f.updater.setChannel("alpha");
  assert.equal((await f.updater.check()).available, false);
});
