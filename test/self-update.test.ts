import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SelfUpdater, compareVersions } from "../extension/self-update.ts";

test("update checks run npm without PATH in directories containing spaces and Chinese characters", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi npm 中文 & "));
  try {
    const cli = join(root, "npm-cli.js");
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "pi-webapp", version: "0.1.0" }));
    await writeFile(cli, 'if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["view", "pi-webapp", "dist-tags.latest", "--json", "--prefer-online"])) process.exit(2); console.log(JSON.stringify("0.2.0"));');
    const moduleUrl = new URL("../extension/self-update.ts", import.meta.url).href;
    const script = `const { SelfUpdater } = await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify(await new SelfUpdater({ packageRoot: process.argv[1], agentDir: process.argv[1] }).check()));`;
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"));
    const stdout = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, root], {
      env: { ...env, PATH: "", npm_execpath: cli }, encoding: "utf8", timeout: 15000,
    });
    assert.deepEqual(JSON.parse(stdout), {
      current: "0.1.0", latest: "0.2.0", available: true, canRestart: false,
      reason: "当前页面由 Pi 终端打开，无法从网页自动重启 Pi；请使用 pi-webapp 启动器。",
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("compares npm release versions numerically", () => {
  assert.ok(compareVersions("0.10.0", "0.9.9") > 0);
  assert.equal(compareVersions("0.9.9", "0.9.9"), 0);
  assert.ok(compareVersions("0.9.8", "0.9.9") < 0);
  assert.throws(() => compareVersions("latest", "0.1.0"), /版本/);
});

test("update checks accept npm string and single-version array results", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-update-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "pi-webapp", version: "0.1.11" }));
    for (const version of ["0.1.10", "0.1.11", "0.2.0"]) {
      for (const result of [version, [version]]) {
        await t.test(JSON.stringify(result), async () => {
          const updater = new SelfUpdater({ agentDir: root, packageRoot: root, launcherNonce: "nonce", runNpm: async () => `\n${JSON.stringify(result)}\n` });
          assert.deepEqual(await updater.check(), { current: "0.1.11", latest: version, available: version === "0.2.0", canRestart: true });
        });
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("update checks reject ambiguous or invalid npm version results", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-update-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "pi-webapp", version: "0.1.11" }));
    for (const result of [[], ["0.2.0", "0.3.0"], [["0.2.0"]], [null], [123], ["latest"], null, { version: "0.2.0" }, "latest"]) {
      await t.test(JSON.stringify(result), async () => {
        const updater = new SelfUpdater({ agentDir: root, packageRoot: root, runNpm: async () => JSON.stringify(result) });
        await assert.rejects(updater.check(), /检查 npm 更新失败：npm 返回的版本号无效/);
      });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("installs a checked npm array release before requesting a supervised restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-update-"));
  const packageRoot = join(root, "source");
  const agentDir = join(root, "agent");
  const calls: string[][] = [];
  try {
    await mkdir(packageRoot);
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "pi-webapp", version: "0.1.0" }));
    const updater = new SelfUpdater({ agentDir, packageRoot, launcherNonce: "nonce-a", runNpm: async (args) => {
      calls.push(args);
      if (args[0] === "view") return '["0.2.0"]';
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
    assert.equal(calls.find((args) => args[0] === "install")?.[1], "pi-webapp@0.2.0");
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
