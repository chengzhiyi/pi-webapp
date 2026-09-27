import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SelfUpdater, compareVersions } from "../extension/self-update.ts";

test("compares npm release versions numerically", () => {
  assert.ok(compareVersions("0.10.0", "0.9.9") > 0);
  assert.equal(compareVersions("0.9.9", "0.9.9"), 0);
  assert.ok(compareVersions("0.9.8", "0.9.9") < 0);
  assert.throws(() => compareVersions("latest", "0.1.0"), /版本/);
});

test("installs a checked release before requesting a supervised restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-update-"));
  const packageRoot = join(root, "source");
  const agentDir = join(root, "agent");
  const calls: string[][] = [];
  try {
    await mkdir(packageRoot);
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "pi-webapp", version: "0.1.0" }));
    const updater = new SelfUpdater({ agentDir, packageRoot, launcherNonce: "nonce-a", runNpm: async (args) => {
      calls.push(args);
      if (args[0] === "view") return '"0.2.0"';
      const prefix = args[args.indexOf("--prefix") + 1];
      const installed = join(prefix, "node_modules", "pi-webapp");
      await mkdir(join(installed, "bin"), { recursive: true });
      await mkdir(join(installed, "dist"));
      await mkdir(join(installed, "web", "dist"), { recursive: true });
      await writeFile(join(installed, "package.json"), JSON.stringify({ name: "pi-webapp", version: "0.2.0" }));
      await writeFile(join(installed, "bin", "pi-webapp.mjs"), "");
      await writeFile(join(installed, "dist", "extension.js"), "");
      await writeFile(join(installed, "web", "dist", "index.html"), "");
      return "";
    } });
    assert.deepEqual(await updater.check(), { current: "0.1.0", latest: "0.2.0", available: true, canRestart: true });
    const prepared = await updater.prepare();
    assert.equal(prepared.version, "0.2.0");
    assert.equal(calls.filter((args) => args[0] === "install").length, 1);
    const manifest = JSON.parse(await readFile(join(agentDir, "pi-web", "update.json"), "utf8"));
    assert.equal(manifest.version, "0.2.0");
    assert.equal(manifest.launcher, prepared.launcher);
    await assert.rejects(updater.prepare(), /正在重启/);
    await updater.requestRestart(prepared);
    const restart = JSON.parse(await readFile(join(agentDir, "pi-web", "launcher.restart"), "utf8"));
    assert.equal(restart.nonce, "nonce-a");
    assert.equal(restart.launcher, prepared.launcher);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("failed install keeps the running release selected", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-update-"));
  const packageRoot = join(root, "source");
  const agentDir = join(root, "agent");
  try {
    await mkdir(packageRoot);
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "pi-webapp", version: "0.1.0" }));
    const updater = new SelfUpdater({ agentDir, packageRoot, launcherNonce: "nonce-a", runNpm: async (args) => {
      if (args[0] === "view") return '"0.2.0"';
      throw new Error("network unavailable");
    } });
    await assert.rejects(updater.prepare(), /network unavailable/);
    await assert.rejects(readFile(join(agentDir, "pi-web", "update.json")));
    await assert.rejects(readFile(join(agentDir, "pi-web", "launcher.restart")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("source checkout reports updates without replacing development files", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-update-"));
  try {
    await mkdir(join(root, ".git"));
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "pi-webapp", version: "0.1.0" }));
    const updater = new SelfUpdater({ agentDir: root, packageRoot: root, launcherNonce: "nonce", runNpm: async () => '"0.2.0"' });
    const status = await updater.check();
    assert.equal(status.available, true);
    assert.equal(status.canRestart, false);
    assert.match(status.reason ?? "", /以免覆盖本地代码/);
    await assert.rejects(updater.prepare(), /源码目录/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
