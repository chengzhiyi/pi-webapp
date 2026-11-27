import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const launcher = fileURLToPath(new URL("../bin/pi-webapp.mjs", import.meta.url));

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-cli-ops-")));
  const agentDir = join(root, "agent");
  const workspace = join(root, "workspace");
  const cli = join(root, "pi.mjs");
  const argsPath = join(root, "args.json");
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("PI_WEBAPP_"))),
    PI_CODING_AGENT_DIR: agentDir, PI_WEBAPP_PI_CLI: cli, PI_WEBAPP_AUTO_OPEN: "0" };
  const run = (args: string[], cwd = root) => exec(process.execPath, [launcher, ...args], { env, cwd, timeout: 10_000 });
  t.after(async () => {
    try { await run(["stop", "--force"]); } finally { await rm(root, { recursive: true, force: true }); }
  });
  await mkdir(workspace);
  await writeFile(cli, `
    import { writeFileSync, existsSync } from 'node:fs';
    import { createInterface } from 'node:readline';
    writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(6), port: process.env.PI_WEBAPP_LISTEN_PORT, host: process.env.PI_WEBAPP_LISTEN_HOST }));
    const lines = createInterface({input: process.stdin});
    lines.on('line', line => {
      const request = JSON.parse(line);
      const send = object => console.log(JSON.stringify(object));
      const command = name => ({name, source: 'extension', sourceInfo: {path: process.argv[5]}});
      if (request.type === 'get_commands') send({type: 'response', id: request.id, success: true, data: {commands: [command('web'), command('web-prepare-stop')]}});
      else if (request.id === 'open-web') send({type: 'extension_ui_request', method: 'notify', message: 'pi-webapp: http://127.0.0.1:' + (process.env.PI_WEBAPP_LISTEN_PORT || '43210') + '/#test-token'});
      else send({type: 'extension_ui_request', method: 'notify', message: 'pi-webapp-stop: ' + JSON.stringify({id: request.id, ok: !existsSync(${JSON.stringify(join(root, "refuse"))})})});
    });
  `);
  return { root, workspace, env, run, args: async () => JSON.parse(await readFile(argsPath, "utf8")), state: async () => JSON.parse(await readFile(join(agentDir, "pi-web", "launcher.json"), "utf8")) };
}

test("restart preserves binding, cwd and Pi arguments; it respects drain refusal", async (t) => {
  const f = await fixture(t);
  await f.run(["start", "--host", "0.0.0.0", "--no-open", "--model", "test model"], f.workspace);
  const before = await f.state();
  await writeFile(join(f.root, "refuse"), "");
  await assert.rejects(f.run(["restart"]), { code: 1, stderr: /停止已取消/ });
  assert.equal((await f.state()).nonce, before.nonce);
  await rm(join(f.root, "refuse"));
  await f.run(["restart"]);
  const after = await f.state();
  assert.notEqual(after.nonce, before.nonce);
  assert.equal(after.restartConfig.noOpen, true);
  assert.deepEqual(await f.args(), { cwd: f.workspace, args: ["--model", "test model"], host: "0.0.0.0", port: "43210" });
});

test("foreground stays attached and drains on SIGINT", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  const child = spawn(process.execPath, [launcher, "start", "--foreground", "--no-open"], { env: f.env, cwd: f.workspace });
  const exit = once(child, "exit");
  let output = "";
  child.stdout.on("data", chunk => { output += chunk.toString(); });
  child.stderr.resume();
  try {
    for (let i = 0; i < 100 && child.exitCode === null && !output.includes("正在前台运行"); i++) await delay(50);
    assert.match(output, /正在前台运行/);
    assert.equal((await f.state()).pid, child.pid);
    await assert.rejects(f.run(["restart"]), { code: 1, stderr: /原终端或服务管理器/ });
    child.kill("SIGINT");
    const outcome = await Promise.race([exit, delay(5000, null, { ref: false })]);
    assert.deepEqual(outcome, [0, null]);
    await assert.rejects(f.state(), { code: "ENOENT" });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      await f.run(["stop", "--force"]).catch(() => child.kill("SIGKILL"));
      await exit;
    }
  }
});
