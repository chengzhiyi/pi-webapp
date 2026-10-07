import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const launcher = fileURLToPath(new URL("../bin/pi-webapp.mjs", import.meta.url));
const extension = fileURLToPath(new URL("../dist/extension.js", import.meta.url));

async function fakePi(path: string): Promise<void> {
  await writeFile(path, '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "0.87.1\\n"; exit 0; fi\nprintf "%s\\n" "$@" > "$PI_TEST_ARGS"\nIFS= read -r line\nprintf "%s\\n" "$line" > "$PI_TEST_RPC_QUERY"\nprintf \'{"type":"response","id":"list-commands","command":"get_commands","success":true,"data":{"commands":[{"name":"%s","source":"extension","sourceInfo":{"path":"%s"}},{"name":"web:2","source":"extension","sourceInfo":{"path":"/other/extension.js"}}]}}\\n\' "${PI_TEST_WEB_NAME:-web}" "$4"\nIFS= read -r line\nprintf "%s\\n" "$line" > "$PI_TEST_RPC_INPUT"\nprintf \'{"type":"extension_ui_request","method":"notify","message":"pi-webapp: http://127.0.0.1:12345/#test-token"}\\n\'\nwhile IFS= read -r line; do :; done\n');
  await chmod(path, 0o755);
}

function run(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [launcher, ...args], { env, encoding: "utf8", timeout: 15000 });
}

interface LifecycleRecord {
  event: string; timestamp: string; instanceId: string; reason?: string;
  ready?: boolean; signal?: string | null; exitCode?: number | null;
  uptimeMs: number; port?: number | null; forceStopRequested?: boolean;
}

async function lifecycleLog(agentDir: string): Promise<LifecycleRecord[]> {
  const log = await readFile(join(agentDir, "pi-web", "launcher.log"), "utf8");
  assert.ok(!log.includes("test-token"), "lifecycle diagnostics must not include the access token");
  return log.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line));
}

test("launcher records Pi lifecycle after readiness", async (t) => {
  for (const mode of ["nonzero_exit", "signal_exit", "requested_stop", "forced_stop"] as const) await t.test(mode,
    { skip: process.platform === "win32" && (mode === "signal_exit" || mode === "forced_stop") }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-web-exit-"));
    const agentDir = join(directory, "agent");
    const trigger = join(directory, "exit-request");
    const env = { ...process.env, PATH: directory, PI_WEBAPP_AUTO_OPEN: "0", PI_CODING_AGENT_DIR: agentDir,
      PI_TEST_ARGS: join(directory, "args"), PI_TEST_RPC_QUERY: join(directory, "query"), PI_TEST_RPC_INPUT: join(directory, "input") };
    try {
      const pi = join(directory, process.platform === "win32" ? "pi.cmd" : "pi");
      const script = process.platform === "win32" ? join(directory, "fake-pi.mjs") : pi;
      await writeFile(script, `#!${process.execPath}
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
if (process.argv[2] === "--version") { console.log("0.87.1"); process.exit(0); }
createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  if (request.type === "get_commands") console.log(JSON.stringify({ type: "response", id: request.id, success: true, data: { commands: [{ name: "web", source: "extension", sourceInfo: { path: process.argv[5] } }] } }));
  else console.log(JSON.stringify({ type: "extension_ui_request", method: "notify", message: "pi-webapp: http://127.0.0.1:12345/#test-token" }));
});
process.stdin.on("end", () => { ${mode === "forced_stop" ? "" : "process.exit(0);"} });
setInterval(() => { if (existsSync(${JSON.stringify(trigger)})) process.exit(7); }, 20);
`);
      if (process.platform === "win32") await writeFile(pi, `@"${process.execPath}" "${script}" %*\r\n`);
      else await chmod(pi, 0o755);
      const started = run([], env);
      assert.equal(started.status, 0, started.stderr);
      const statePath = join(agentDir, "pi-web", "launcher.json");
      const state = JSON.parse(await readFile(statePath, "utf8"));
      if (mode === "signal_exit") process.kill(state.piPid, "SIGTERM");
      else if (mode === "nonzero_exit") await writeFile(trigger, "exit");
      else { const stopped = run(["stop"], env); assert.equal(stopped.status, 0, stopped.stderr); }
      for (let attempt = 0; attempt < 150 && existsSync(statePath); attempt++) await delay(20);
      const records = await lifecycleLog(agentDir);
      const ready = records.find(record => record.event === "launcher_ready");
      const exited = records.filter(record => record.event === "pi_process_exit");
      assert.ok(ready, "readiness must be logged before a later exit");
      assert.equal(exited.length, 1);
      assert.equal(exited[0]!.reason, mode.endsWith("stop") ? "stop_request" : "unexpected_exit");
      assert.equal(exited[0]!.ready, true);
      assert.equal(exited[0]!.instanceId, ready.instanceId);
      assert.equal(exited[0]!.signal, mode === "signal_exit" || mode === "forced_stop" ? "SIGTERM" : null);
      assert.equal(exited[0]!.exitCode, mode === "nonzero_exit" ? 7 : mode === "requested_stop" ? 0 : null);
      assert.equal(exited[0]!.forceStopRequested, mode === "forced_stop");
      if (mode === "forced_stop") assert.equal(records.filter(record => record.event === "pi_force_stop").length, 1);
      assert.ok(Number.isFinite(Date.parse(exited[0]!.timestamp)));
      assert.ok(exited[0]!.uptimeMs >= 0);
      assert.notEqual(ready.instanceId, state.nonce, "log identity must not reuse the control nonce");
    } finally { run(["stop"], env); await rm(directory, { recursive: true, force: true }); }
  });
});

test("launcher starts Pi RPC in the background and stops it cleanly", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-launch-"));
  const argsFile = join(directory, "args");
  const rpcInput = join(directory, "rpc-input");
  const rpcQuery = join(directory, "rpc-query");
  const opened = join(directory, "opened");
  const env = { ...process.env, PATH: directory, DISPLAY: ":0", SSH_CONNECTION: undefined, SSH_TTY: undefined, SSH_CLIENT: undefined, PI_WEBAPP_AUTO_OPEN: "1", PI_CODING_AGENT_DIR: join(directory, "agent"), PI_TEST_ARGS: argsFile, PI_TEST_RPC_QUERY: rpcQuery, PI_TEST_RPC_INPUT: rpcInput, PI_TEST_WEB_NAME: "web:1", PI_TEST_OPENED: opened };
  try {
    await fakePi(join(directory, "pi"));
    const opener = join(directory, process.platform === "darwin" ? "open" : "xdg-open");
    await writeFile(opener, '#!/bin/sh\nprintf "%s\\n" "$1" >> "$PI_TEST_OPENED"\n');
    await chmod(opener, 0o755);
    const started = run([], env);
    assert.equal(started.status, 0, started.stderr);
    assert.match(started.stdout, /后台运行/);
    assert.deepEqual((await readFile(argsFile, "utf8")).trimEnd().split("\n"), ["--mode", "rpc", "-e", extension]);
    assert.deepEqual(JSON.parse(await readFile(rpcQuery, "utf8")), { id: "list-commands", type: "get_commands" });
    assert.deepEqual(JSON.parse(await readFile(rpcInput, "utf8")), { id: "open-web", type: "prompt", message: "/web:1" });
    const statePath = join(directory, "agent", "pi-web", "launcher.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.ok(state.pid > 0);
    assert.equal((await stat(statePath)).mode & 0o777, 0o600);
    assert.deepEqual((await readFile(opened, "utf8")).trimEnd().split("\n"), [state.url]);
    assert.equal(run([], env).status, 0);
    assert.equal(JSON.parse(await readFile(statePath, "utf8")).pid, state.pid);
    assert.deepEqual((await readFile(opened, "utf8")).trimEnd().split("\n"), [state.url, state.url]);
    assert.equal(run(["status"], env).status, 0);
    const stopped = run(["stop"], env);
    assert.equal(stopped.status, 0, stopped.stderr);
    await assert.rejects(readFile(statePath));
    const records = await lifecycleLog(join(directory, "agent"));
    const ready = records.filter(record => record.event === "launcher_ready");
    assert.equal(ready.length, 1, "opening the running service must not create a new lifecycle");
    assert.equal(ready[0]!.port, 12345);
    const exited = records.filter(record => record.event === "pi_process_exit");
    assert.equal(exited.length, 1);
    assert.equal(exited[0]!.instanceId, ready[0]!.instanceId);
    assert.equal(exited[0]!.reason, "stop_request");
    assert.equal(exited[0]!.exitCode, 0);
    assert.equal(exited[0]!.signal, null);
  } finally {
    run(["stop"], env);
    await rm(directory, { recursive: true, force: true });
  }
});

test("launcher reports a Pi startup failure and clears the background state", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-launch-"));
  const env = { ...process.env, PATH: directory, PI_CODING_AGENT_DIR: join(directory, "agent") };
  try {
    const pi = join(directory, "pi");
    await writeFile(pi, '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "0.87.1\\n"; exit 0; fi\nexit 7\n');
    await chmod(pi, 0o755);
    const started = run([], env);
    assert.equal(started.status, 1);
    assert.match(started.stderr, /Pi 提前退出|无法向 Pi 发送启动命令/);
    const statePath = join(directory, "agent", "pi-web", "launcher.json");
    // The parent receives the failure before the background worker finishes cleanup.
    for (let attempt = 0; attempt < 150 && existsSync(statePath); attempt++) await delay(20);
    await assert.rejects(readFile(statePath), { code: "ENOENT" });
  } finally {
    run(["stop"], env);
    await rm(directory, { recursive: true, force: true });
  }
});

test("launcher installs Pi when missing before starting the background RPC host", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-launch-"));
  const source = join(directory, "pi-source");
  const npmArgsFile = join(directory, "npm-args");
  const env = { ...process.env, PATH: directory, npm_execpath: join(directory, "npm-cli.js"), PI_CODING_AGENT_DIR: join(directory, "agent"), PI_TEST_ARGS: join(directory, "args"), PI_TEST_RPC_QUERY: join(directory, "rpc-query"), PI_TEST_RPC_INPUT: join(directory, "rpc-input"), PI_TEST_NPM_ARGS: npmArgsFile, PI_TEST_PI_SOURCE: source, PI_TEST_BIN: directory };
  try {
    await fakePi(source);
    await writeFile(env.npm_execpath, 'const fs = require("node:fs"); const path = require("node:path"); fs.writeFileSync(process.env.PI_TEST_NPM_ARGS, process.argv.slice(2).join("\\n") + "\\n"); fs.copyFileSync(process.env.PI_TEST_PI_SOURCE, path.join(process.env.PI_TEST_BIN, "pi")); fs.chmodSync(path.join(process.env.PI_TEST_BIN, "pi"), 0o755);');
    const started = run([], env);
    assert.equal(started.status, 0, started.stderr);
    assert.match(started.stdout, /后台运行/);
    assert.deepEqual((await readFile(npmArgsFile, "utf8")).trimEnd().split("\n"), ["install", "-g", "--ignore-scripts", "@earendil-works/pi-coding-agent"]);
    assert.equal(run(["stop"], env).status, 0);
  } finally {
    run(["stop"], env);
    await rm(directory, { recursive: true, force: true });
  }
});

test("launcher leaves an incompatible Pi installation untouched", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-launch-"));
  try {
    const pi = join(directory, "pi");
    await writeFile(pi, '#!/bin/sh\nprintf "0.86.0\\n"\n');
    await chmod(pi, 0o755);
    const npm = join(directory, "npm");
    await writeFile(npm, '#!/bin/sh\nprintf "called" > "$PI_TEST_NPM_ARGS"\n');
    await chmod(npm, 0o755);
    const npmArgsFile = join(directory, "npm-args");
    const result = run([], { ...process.env, PATH: directory, PI_CODING_AGENT_DIR: join(directory, "agent"), PI_TEST_NPM_ARGS: npmArgsFile });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /0\.87\.1/);
    await assert.rejects(readFile(npmArgsFile));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("launcher restarts a prepared release at the same browser address", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-restart-"));
  const agentDir = join(directory, "agent");
  const launchRecord = join(directory, "next-launch.json");
  const nextLauncher = join(directory, "next-launcher.mjs");
  const env = { ...process.env, PATH: directory, PI_WEBAPP_AUTO_OPEN: "0", PI_CODING_AGENT_DIR: agentDir,
    PI_TEST_ARGS: join(directory, "args"), PI_TEST_RPC_QUERY: join(directory, "rpc-query"), PI_TEST_RPC_INPUT: join(directory, "rpc-input"), PI_TEST_LAUNCH_RECORD: launchRecord };
  try {
    await fakePi(join(directory, "pi"));
    await writeFile(nextLauncher, 'import { writeFileSync } from "node:fs"; writeFileSync(process.env.PI_TEST_LAUNCH_RECORD, JSON.stringify({ args: process.argv.slice(2), port: process.env.PI_WEBAPP_RESTART_PORT, token: process.env.PI_WEBAPP_RESTART_TOKEN }));');
    assert.equal(run(["start", "--test-arg"], env).status, 0);
    const statePath = join(agentDir, "pi-web", "launcher.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    await writeFile(join(agentDir, "pi-web", "update.json"), JSON.stringify({ version: "0.2.0", launcher: nextLauncher }));
    await writeFile(join(agentDir, "pi-web", "launcher.restart"), JSON.stringify({ nonce: state.nonce, launcher: nextLauncher }));
    for (let attempt = 0; attempt < 80; attempt++) {
      try { await readFile(launchRecord); break; } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
    const record = JSON.parse(await readFile(launchRecord, "utf8"));
    const address = new URL(state.url);
    assert.deepEqual(record.args, ["start", "--test-arg"]);
    assert.equal(record.port, address.port);
    assert.equal(record.token, address.hash.slice(1));
    const exited = (await lifecycleLog(agentDir)).find(record => record.event === "pi_process_exit");
    assert.ok(exited);
    assert.equal(exited.reason, "restart_request");
    assert.equal(exited.exitCode, 0);
  } finally {
    run(["stop"], env);
    await rm(directory, { recursive: true, force: true });
  }
});

test("launcher restores the previous service if the prepared release cannot start", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-rollback-"));
  const agentDir = join(directory, "agent");
  const nextLauncher = join(directory, "broken-launcher.mjs");
  const env = { ...process.env, PATH: directory, PI_WEBAPP_AUTO_OPEN: "0", PI_CODING_AGENT_DIR: agentDir,
    PI_TEST_ARGS: join(directory, "args"), PI_TEST_RPC_QUERY: join(directory, "rpc-query"), PI_TEST_RPC_INPUT: join(directory, "rpc-input") };
  try {
    await fakePi(join(directory, "pi"));
    await writeFile(nextLauncher, "process.exit(3);");
    assert.equal(run([], env).status, 0);
    const statePath = join(agentDir, "pi-web", "launcher.json");
    const first = JSON.parse(await readFile(statePath, "utf8"));
    const updatePath = join(agentDir, "pi-web", "update.json");
    await writeFile(updatePath, JSON.stringify({ version: "0.2.0", launcher: nextLauncher }));
    await writeFile(join(agentDir, "pi-web", "launcher.restart"), JSON.stringify({ nonce: first.nonce, launcher: nextLauncher }));
    let recovered = null;
    for (let attempt = 0; attempt < 80; attempt++) {
      try {
        const state = JSON.parse(await readFile(statePath, "utf8"));
        if (state.nonce !== first.nonce && state.url) { recovered = state; break; }
      } catch { /* Restart in progress. */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(recovered, "previous release should be started again");
    assert.equal(recovered.url, first.url);
    await assert.rejects(readFile(updatePath));
  } finally {
    run(["stop"], env);
    await rm(directory, { recursive: true, force: true });
  }
});
