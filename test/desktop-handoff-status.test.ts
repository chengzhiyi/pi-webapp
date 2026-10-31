import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SelfUpdater } from "../src/host/server/updates/self-update.ts";
import type { UpdateStatus } from "../src/contracts/bridge-contract.ts";

type HandoffStatus = UpdateStatus & { launcherHandoff?: { supported: boolean; required: boolean } };

async function fixture(t: test.TestContext, protocol?: number) {
  const inherited = process.env.PI_WEBAPP_LAUNCHER_HANDOFF_PROTOCOL;
  if (protocol) process.env.PI_WEBAPP_LAUNCHER_HANDOFF_PROTOCOL = String(protocol);
  else delete process.env.PI_WEBAPP_LAUNCHER_HANDOFF_PROTOCOL;
  t.after(() => { if (inherited === undefined) delete process.env.PI_WEBAPP_LAUNCHER_HANDOFF_PROTOCOL; else process.env.PI_WEBAPP_LAUNCHER_HANDOFF_PROTOCOL = inherited; });
  const root = await mkdtemp(join(tmpdir(), "pi-old-launcher-status-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = join(root, "business"), agentDir = join(root, "agent");
  await mkdir(packageRoot); await mkdir(join(agentDir, "pi-web"), { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "pi-webapp", version: "0.1.44", piWebappDesktopProtocol: 1 }));
  await writeFile(join(agentDir, "pi-web", "launcher.json"), JSON.stringify({ pid: process.pid, nonce: "old-owner", runtimeKind: "desktop",
    version: "0.1.44", bridgeVersion: 1, desktopProtocolVersion: 1, ...(protocol ? { launcherHandoffProtocol: protocol } : {}) }));
  const calls: string[][] = [];
  const updater = new SelfUpdater({ agentDir, packageRoot, launcherNonce: "old-owner", desktopManaged: true,
    desktopPackageUpdates: true, desktopReleaseChannels: false,
    runNpm: async args => {
      calls.push(args);
      assert.equal(args[0], "view", "a blocked preview must not install code");
      return JSON.stringify(args[2] === "dist-tags" ? { latest: "0.1.45", alpha: "0.2.0-alpha.1" } : "0.1.45");
    } });
  return { updater, agentDir, calls };
}

test("an inherited false preview capability requests a launcher handoff instead of repeatedly telling a new desktop to reinstall", async t => {
  const f = await fixture(t, 1);
  await f.updater.setChannel("alpha");
  const status = await f.updater.check() as HandoffStatus;
  assert.deepEqual(status.launcherHandoff, { supported: true, required: true });
  assert.equal(status.canRestart, false, "displaying a new shell must not forge the old launcher's capabilities");
  assert.notEqual(status.requiresDesktopUpgrade, true);
  assert.match(status.reason ?? "", /启动器/);
  assert.match(status.reason ?? "", /交接|接管/);
  assert.doesNotMatch(status.reason ?? "", /请先安装|重新安装/);
  await assert.rejects(f.updater.prepare());
  assert.equal(f.calls.some(args => args[0] === "install"), false);
  for (const name of ["desktop-update.json", "launcher.restart", "launcher.stop", "launcher-handoff.json"]) {
    await assert.rejects(readFile(join(f.agentDir, "pi-web", name)), { code: "ENOENT" });
  }
});

test("an old supervisor without handoff support directs a stable business-package update without enabling preview unsafely", async t => {
  const f = await fixture(t);
  await f.updater.setChannel("alpha");
  const status = await f.updater.check() as HandoffStatus;
  assert.deepEqual(status.launcherHandoff, { supported: false, required: true });
  assert.equal(status.canRestart, false);
  assert.notEqual(status.requiresDesktopUpgrade, true);
  assert.match(status.reason ?? "", /稳定.*业务包|业务包.*稳定/);
  await f.updater.setChannel("stable");
  const stable = await f.updater.check();
  assert.equal(stable.canRestart, true, "the supported stable bootstrap path must remain available");
  assert.equal(stable.available, true);
  assert.equal(stable.latest, "0.1.45");
});
