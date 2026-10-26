import { cpSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// Exercise the actual package-version rewrite/build/bootstrap sequence without
// mutating the checkout, querying npm, publishing, or depending on source version.
const root = fileURLToPath(new URL("../", import.meta.url));
const candidate = mkdtempSync(join(tmpdir(), "pi-release-host-"));
try {
  cpSync(root, candidate, {
    recursive: true,
    filter: path => !relative(root, path).split(/[\\/]/).some(part => [".git", ".ci", ".paperclip", "node_modules"].includes(part)),
  });
  symlinkSync(resolve(root, "node_modules"), join(candidate, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const run = (command, args) => execFileSync(command, args, { cwd: candidate, stdio: "inherit", env: process.env });
  run(process.platform === "win32" ? "npm.cmd" : "npm", ["version", "0.1.31-alpha.5", "--no-git-tag-version", "--allow-same-version", "--ignore-scripts"]);
  run(process.execPath, ["scripts/build.mjs"]);
  run(process.execPath, ["--import", "./test/setup-env.mjs", "--experimental-strip-types", "--test", "--test-concurrency=1",
    "test/auto-open.test.ts", "test/extension-flow.test.ts", "test/hosted-bootstrap.test.ts", "test/hosted-installation.test.ts"]);
} finally {
  rmSync(candidate, { recursive: true, force: true });
}
