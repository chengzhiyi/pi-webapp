import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { prepareTerminalHelper } from "../src/plugins/builtin/terminal/server/pty.ts";

const require = createRequire(import.meta.url);

test("macOS terminal recovers a clean node-pty install with lifecycle scripts skipped", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-terminal-helper-"));
  try {
    const ptyRoot = join(root, "node-pty");
    await cp(dirname(require.resolve("node-pty/package.json")), ptyRoot, { recursive: true });
    // Force the published prebuild path even if the development install has a source build.
    await rm(join(ptyRoot, "build"), { recursive: true, force: true });
    const helper = join(ptyRoot, "prebuilds", `darwin-${process.arch}`, "spawn-helper");
    await chmod(helper, 0o644);
    const run = () => spawnSync(process.execPath, ["-e", `
      const pty = require(process.argv[1]);
      const terminal = pty.spawn('/bin/sh', ['-c', 'printf HELPER_REPAIRED'], { cwd: process.argv[2], cols: 80, rows: 24 });
      let output = '';
      terminal.onData(data => output += data);
      terminal.onExit(() => { process.stdout.write(output); process.exitCode = output.includes('HELPER_REPAIRED') ? 0 : 1; });
    `, ptyRoot, root], { encoding: "utf8", timeout: 10000 });
    const before = run();
    assert.notEqual(before.status, 0, "unexecutable published helper must reproduce startup failure");
    assert.match(before.stderr, /posix_spawnp failed/);
    prepareTerminalHelper(ptyRoot);
    assert.equal((await stat(helper)).mode & 0o777, 0o755);
    const after = run();
    assert.equal(after.status, 0, after.stderr);
    assert.match(after.stdout, /HELPER_REPAIRED/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("helper preparation covers source builds and leaves executable app resources untouched", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-terminal-source-helper-"));
  try {
    for (const directory of ["build/Release", "build/Debug", `prebuilds/darwin-${process.arch}`]) {
      await mkdir(join(root, directory), { recursive: true });
      const helper = join(root, directory, "spawn-helper");
      await writeFile(helper, "fixture");
      await chmod(helper, directory === "build/Debug" ? 0o555 : 0o644);
    }
    const executable = join(root, "build/Debug/spawn-helper");
    const before = await stat(executable);
    prepareTerminalHelper(root);
    const after = await stat(executable);
    assert.equal(after.mode, before.mode);
    assert.equal(after.ctimeMs, before.ctimeMs, "already executable/signed helpers must not be chmodded");
    assert.equal((await stat(join(root, "build/Release/spawn-helper"))).mode & 0o777, 0o755);
    assert.equal((await stat(join(root, `prebuilds/darwin-${process.arch}/spawn-helper`))).mode & 0o777, 0o755);
    assert.doesNotThrow(() => prepareTerminalHelper(join(root, "missing")));
  } finally { await rm(root, { recursive: true, force: true }); }
});
