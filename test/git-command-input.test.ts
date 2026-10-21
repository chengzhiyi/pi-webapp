import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const command = fileURLToPath(new URL("../extension/git-command.ts", import.meta.url));
// A separate process turns an unhandled stdin error into a deterministic test
// failure without crashing the test runner. The shim never modifies a real repo.
async function probe(t: { after(fn: () => Promise<void>): void }, exitCode: number | null) {
  const root = await mkdtemp(join(tmpdir(), "pi-git-input-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const shim = join(root, "git");
  await writeFile(shim, `#!/usr/bin/env node\n${exitCode === null
    ? "let size=0;process.stdin.on('data',b=>size+=b.length);process.stdin.on('end',()=>process.stdout.write(String(size)));"
    : `require('node:fs').closeSync(0);process.stderr.write('fixture rejected before input');setTimeout(()=>process.exit(${exitCode}),20);`}\n`);
  await chmod(shim, 0o755);
  const script = join(root, "probe.mjs");
  await writeFile(script, `import {git} from ${JSON.stringify(pathToFileURL(command).href)};
try {
  const result=await git(${JSON.stringify(root)},['commit'],1024*1024,{write:true,input:'x'.repeat(8*1024*1024)});
  process.stdout.write(JSON.stringify({ok:true,result}));
} catch(error) {
  process.stdout.write(JSON.stringify({ok:false,name:error.name,status:error.status,reason:error.reason}));
}
`);
  const { stdout } = await promisify(execFile)(process.execPath, ["--experimental-strip-types", script], {
    env: { ...process.env, PATH: [root, dirname(process.execPath), process.env.PATH ?? ""].join(delimiter) }, timeout: 15000,
  });
  return JSON.parse(stdout);
}

test("early Git rejection closes stdin without an unhandled EPIPE or lost failure classification", { skip: process.platform === "win32" }, async t => {
  assert.deepEqual(await probe(t, 1), { ok: false, name: "WorkspaceGitError", status: 409, reason: "git_failed" });
});

test("successful Git exit with undelivered input is an unknown outcome, never reported as success", { skip: process.platform === "win32" }, async t => {
  assert.deepEqual(await probe(t, 0), { ok: false, name: "WorkspaceGitError", status: 503, reason: "outcome_unknown" });
});

test("Git consuming the full stdin still returns normal success", { skip: process.platform === "win32" }, async t => {
  assert.deepEqual(await probe(t, null), { ok: true, result: String(8 * 1024 * 1024) });
});
