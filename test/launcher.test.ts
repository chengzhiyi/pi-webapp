import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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

test("launcher starts Pi RPC in the background and stops it cleanly", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-launch-"));
  const argsFile = join(directory, "args");
  const rpcInput = join(directory, "rpc-input");
  const rpcQuery = join(directory, "rpc-query");
  const env = { ...process.env, PATH: directory, PI_CODING_AGENT_DIR: join(directory, "agent"), PI_TEST_ARGS: argsFile, PI_TEST_RPC_QUERY: rpcQuery, PI_TEST_RPC_INPUT: rpcInput, PI_TEST_WEB_NAME: "web:1" };
  try {
    await fakePi(join(directory, "pi"));
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
    assert.equal(run([], env).status, 0);
    assert.equal(JSON.parse(await readFile(statePath, "utf8")).pid, state.pid);
    assert.equal(run(["status"], env).status, 0);
    const stopped = run(["stop"], env);
    assert.equal(stopped.status, 0, stopped.stderr);
    await assert.rejects(readFile(statePath));
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
    assert.match(started.stderr, /Pi 提前退出/);
    await assert.rejects(readFile(join(directory, "agent", "pi-web", "launcher.json")));
  } finally {
    run(["stop"], env);
    await rm(directory, { recursive: true, force: true });
  }
});

test("launcher installs Pi when missing before starting the background RPC host", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-launch-"));
  const source = join(directory, "pi-source");
  const npmArgsFile = join(directory, "npm-args");
  const env = { ...process.env, PATH: directory, PI_CODING_AGENT_DIR: join(directory, "agent"), PI_TEST_ARGS: join(directory, "args"), PI_TEST_RPC_QUERY: join(directory, "rpc-query"), PI_TEST_RPC_INPUT: join(directory, "rpc-input"), PI_TEST_NPM_ARGS: npmArgsFile, PI_TEST_PI_SOURCE: source, PI_TEST_BIN: directory };
  try {
    await fakePi(source);
    const npm = join(directory, "npm");
    await writeFile(npm, '#!/bin/sh\nprintf "%s\\n" "$@" > "$PI_TEST_NPM_ARGS"\n/bin/cp "$PI_TEST_PI_SOURCE" "$PI_TEST_BIN/pi"\n/bin/chmod +x "$PI_TEST_BIN/pi"\n');
    await chmod(npm, 0o755);
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
