import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { npmCommand, resolveNpmCli } from "../bin/npm-command.mjs";

for (const layout of ["windows", "unix"]) {
  test(`finds npm beside Node in a ${layout} installation without PATH`, async () => {
    const root = await mkdtemp(join(tmpdir(), "pi npm 中文 & "));
    try {
      const execPath = join(root, "bin", "node");
      const cli = layout === "windows"
        ? join(root, "bin", "node_modules", "npm", "bin", "npm-cli.js")
        : join(root, "lib", "node_modules", "npm", "bin", "npm-cli.js");
      await mkdir(dirname(cli), { recursive: true });
      await writeFile(cli, "");
      const resolved = resolveNpmCli({ execPath, env: { PATH: "", npm_execpath: join(root, "missing", "npm-cli.js") } });
      // Normalize both sides with the same API; Windows sync realpath can retain 8.3 aliases.
      assert.equal(await realpath(resolved), await realpath(cli));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test("finds npm installed separately on a case-insensitive Windows Path", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-npm-path-"));
  try {
    const cli = join(root, "node_modules", "npm", "bin", "npm-cli.js");
    await mkdir(dirname(cli), { recursive: true });
    await writeFile(cli, "");
    const resolved = resolveNpmCli({ execPath: join(root, "elsewhere", "node"), env: { Path: root } });
    assert.equal(await realpath(resolved), await realpath(cli));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("ignores another package manager's npm_execpath and explains when npm is absent", () => {
  assert.throws(() => resolveNpmCli({ execPath: join(tmpdir(), "missing-node", "node"), env: { PATH: "", npm_execpath: import.meta.filename } }), /找不到 npm 入口 npm-cli.js/);
});

test("runs the installed npm with the current Node and an empty PATH", () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path" && key !== "npm_execpath"));
  const moduleUrl = new URL("../bin/npm-command.mjs", import.meta.url).href;
  const script = `const { npmCommand } = await import(${JSON.stringify(moduleUrl)}); const { execFileSync } = await import('node:child_process'); const command = npmCommand(['--version']); console.log(execFileSync(command.file, command.args, { encoding: 'utf8' }).trim());`;
  const version = execFileSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...env, PATH: "" }, encoding: "utf8", timeout: 15000 });
  assert.match(version.trim(), /^\d+\.\d+\.\d+$/);
  assert.equal(npmCommand(["--version"]).file, process.execPath);
});
