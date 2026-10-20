import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { nativeBuildEnvironment, prepareNativePty } from "../../scripts/desktop-native.mjs";
const { checkPty } = createRequire(import.meta.url)("../check-pty.cjs");

test("Linux PTY rebuild is explicitly targeted to bundled Node and headers, never inherited Electron settings", async () => {
  const env = nativeBuildEnvironment({ PATH: "safe", npm_config_runtime: "electron", NPM_CONFIG_TARGET: "44.9.0",
    npm_config_disturl: "https://electron.invalid", NODE_OPTIONS: "--inspect", ELECTRON_RUN_AS_NODE: "1" }, "22.23.3", "/bundled/node");
  assert.equal(env.npm_config_runtime, "node"); assert.equal(env.npm_config_target, "22.23.3");
  assert.equal(env.npm_config_nodedir, "/bundled/node"); assert.equal(env.npm_config_build_from_source, "true");
  assert.equal(env.NPM_CONFIG_TARGET, undefined); assert.equal(env.npm_config_disturl, undefined); assert.equal(env.NODE_OPTIONS, undefined);
  const calls = [];
  const result = await prepareNativePty({ platform: "linux", arch: "x64", node: "/bundled/node/bin/node", nodeRoot: "/bundled/node",
    nodeVersion: "22.23.3", npmCli: "/bundled/npm-cli.js", backend: "/stage/backend", env,
    run: async (...args) => calls.push(args) });
  assert.equal(result, "bundled-node-source-build"); assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], ["/bundled/npm-cli.js", "rebuild", "node-pty", "--no-audit", "--no-fund"]);
  assert.equal(calls[0][2].cwd, "/stage/backend"); assert.equal(calls[0][2].env.npm_config_runtime, "node");
});

test("Windows executes only the pinned PTY post-install payload preparation with bundled Node", async () => {
  const calls = [];
  await prepareNativePty({ platform: "win32", arch: "x64", node: "/runtime/node.exe", backend: "/stage/backend", env: {}, run: async (...args) => calls.push(args) });
  assert.equal(calls.length, 1); assert.equal(calls[0][0], "/runtime/node.exe");
  assert.match(calls[0][1][0].replaceAll("\\", "/"), /node-pty\/scripts\/post-install.js$/);
  assert.ok(!calls[0][1].includes("ci"));
});

function fixture({ emitMarker = true, emitExit = true } = {}) {
  let output, exit, reply, disposed = false, killed = false;
  const writes = [];
  const terminal = { onData(fn) { output = fn; }, onExit(fn) { exit = fn; }, kill() { killed = true; }, write(data) {
    writes.push(data);
    if (writes.length === 1) queueMicrotask(() => {
      output("\x1b[6n");
      if (emitMarker) output("PI_DESKTOP_PTY_OK\r\n");
      if (emitExit) exit({ exitCode: 0 });
    });
  } };
  class Terminal { onData(fn) { reply = fn; } write(data) { if (data.includes("\x1b[6n")) reply("\x1b[1;1R"); } dispose() { disposed = true; } }
  return { pty: { spawn(shell, args) { assert.equal(shell, "cmd.exe"); assert.deepEqual(args, ["/d", "/q"]); return terminal; } }, Terminal,
    platform: "win32", env: {}, timeoutMs: 100, writes, disposed: () => disposed, killed: () => killed };
}

test("PTY probe uses an interactive shell, answers terminal queries and requires output plus a clean exit", async () => {
  const f = fixture(); await checkPty(f);
  assert.ok(f.writes[0].includes("%PI_DESKTOP_PROBE_SUFFIX%")); assert.ok(!f.writes[0].includes("PI_DESKTOP_PTY_OK"));
  assert.equal(f.writes[1], "\x1b[1;1R"); assert.equal(f.disposed(), true);
  const missing = fixture({ emitMarker: false }); await assert.rejects(checkPty(missing), /expected output/);
  assert.equal(missing.killed(), true);
  const stuck = fixture({ emitExit: false }); await assert.rejects(checkPty(stuck), /timed out/);
  assert.equal(stuck.killed(), true);
});
