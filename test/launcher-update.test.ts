import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const project = fileURLToPath(new URL("../", import.meta.url));

async function fixture(t: Pick<import("node:test").TestContext, "after">, latest = "1.2.4", global = true) {
  const root = await mkdtemp(join(tmpdir(), "pi-launcher-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const globalRoot = join(root, "global modules");
  const agentDir = join(root, "agent");
  const pkg = join(global ? globalRoot : root, "pi-webapp");
  const npm = join(root, "npm-cli.js");
  const npmLog = join(root, "npm.log");
  await mkdir(pkg, { recursive: true });
  await cp(join(project, "bin"), join(pkg, "bin"), { recursive: true });
  await cp(join(project, "desktop"), join(pkg, "desktop"), { recursive: true, filter: (source) => source === join(project, "desktop") || source.endsWith(".mjs") });
  await symlink(join(project, "node_modules"), join(pkg, "node_modules"), "junction");
  await writeFile(join(pkg, "package.json"), JSON.stringify({ version: "1.2.3" }));
  await writeFile(npm, `
    const args = process.argv.slice(2);
    require('node:fs').appendFileSync(${JSON.stringify(npmLog)}, JSON.stringify(args) + '\\n');
    if (args[0] === 'root') console.log(${JSON.stringify(globalRoot)});
    else if (args[0] === 'view') console.log(JSON.stringify(${JSON.stringify(latest)}));
    else if (args[0] !== 'install') process.exitCode = 1;
  `);
  const env = { ...process.env, npm_execpath: npm, PI_WEBAPP_RUNTIME: "npm", PI_CODING_AGENT_DIR: agentDir };
  return {
    run: (...args: string[]) => exec(process.execPath, [join(pkg, "bin/pi-webapp.mjs"), ...args], { cwd: root, env, timeout: 5000 }),
    calls: async () => (await readFile(npmLog, "utf8")).trim().split("\n").map(line => JSON.parse(line)),
    npmLog,
    agentDir,
  };
}

const view = ["view", "pi-webapp@latest", "version", "--json"];

test("CLI version, help and invalid update arguments do not invoke npm", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run("--version")).stdout.trim(), "1.2.3");
  assert.equal((await f.run("-v")).stdout.trim(), "1.2.3");
  assert.match((await f.run("--help")).stdout, /update \[--check\]/);
  assert.match((await f.run("update", "--help")).stdout, /update \[--check\]/);
  await assert.rejects(f.run("update", "--install-anyway"), { code: 1, stderr: /用法/ });
  await assert.rejects(readFile(f.npmLog), { code: "ENOENT" });
});

test("update --check works on local copies without installing", async (t) => {
  const f = await fixture(t, "1.2.4", false);
  assert.match((await f.run("update", "--check")).stdout, /有可用更新/);
  await assert.rejects(f.run("update"), { code: 1, stderr: /仅支持自更新通过 npm 全局安装/ });
  assert.deepEqual(await f.calls(), [view, ["root", "-g"]]);
});

test("update installs the exact checked version of a global package", async (t) => {
  const f = await fixture(t);
  assert.match((await f.run("update")).stdout, /CLI 已更新至 1\.2\.4/);
  assert.deepEqual(await f.calls(), [["root", "-g"], view, ["install", "-g", "pi-webapp@1.2.4"]]);
});

test("update refuses to replace a global package while the service is running", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.agentDir, "pi-web"), { recursive: true });
  await writeFile(join(f.agentDir, "pi-web", "launcher.json"), JSON.stringify({ pid: process.pid }));
  await assert.rejects(f.run("update"), { code: 1, stderr: /请先完成任务并执行 pi-webapp stop/ });
  assert.deepEqual(await f.calls(), [["root", "-g"], view]);
});

test("update never installs an older or invalid registry version", async (t) => {
  const older = await fixture(t, "1.2.2");
  assert.match((await older.run("update")).stdout, /不会降级/);
  assert.deepEqual(await older.calls(), [["root", "-g"], view]);
  const invalid = await fixture(t, "file:unexpected");
  await assert.rejects(invalid.run("update"), { code: 1, stderr: /最新版本无效/ });
  assert.deepEqual(await invalid.calls(), [["root", "-g"], view]);
});
