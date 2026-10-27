import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import test from "node:test";

// The publishing job runs on Ubuntu. Executable shims guarantee these tests
// never call a real registry or git remote.
test("verified publishing chooses the correct npm tag and rejects stale/mismatched receipts", { skip: process.platform === "win32" }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-publish-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, ".ci", "release"); await mkdir(directory, { recursive: true });
  const bin = join(root, "fake-bin"); await mkdir(bin);
  const record = join(root, "npm.json");
  for (const [name, code] of [
    ["npm", 'import { writeFileSync } from "node:fs"; writeFileSync(process.env.PI_TEST_PUBLISH_RECORD, JSON.stringify(process.argv.slice(2)));'],
    ["git", 'console.log(process.env.PI_TEST_HEAD + "\\t" + process.env.GITHUB_REF);'],
  ]) {
    const file = join(bin, name);
    await writeFile(file, `#!${process.execPath}\n${code}\n`); await chmod(file, 0o755);
  }
  // Make the extension-less Node shims ES modules.
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  const sha = "a".repeat(40);
  const bytes = Buffer.from("verified package test bytes");
  await writeFile(join(directory, "package.tgz"), bytes);
  const script = fileURLToPath(new URL("../scripts/publish-verified-release.mjs", import.meta.url));
  for (const scenario of [
    { ref: "main", version: "0.2.0", channel: "stable", tag: "latest", succeeds: true },
    { ref: "alpha", version: "0.2.0-alpha.2", channel: "alpha", tag: "alpha", succeeds: true },
    { ref: "main", version: "0.2.0", channel: "stable", tag: "latest", disabled: true, succeeds: true },
    { ref: "alpha", version: "0.2.0-alpha.2", channel: "alpha", tag: "alpha", disabled: true, succeeds: true },
    { ref: "alpha", version: "0.2.0-alpha.2", channel: "alpha", tag: "latest", succeeds: false },
    { ref: "main", version: "0.2.0-alpha.2", channel: "stable", tag: "latest", succeeds: false },
    { ref: "feature/test", version: "0.2.0", channel: "stable", tag: "latest", succeeds: false },
    { ref: "main", version: "0.2.0", channel: "stable", tag: "latest", source: "b".repeat(40), succeeds: false },
    { ref: "main", version: "0.2.0", channel: "stable", tag: "latest", head: "b".repeat(40), succeeds: false },
  ]) {
    await rm(record, { force: true });
    await writeFile(join(directory, "verified.json"), JSON.stringify({ filename: "package.tgz", sha256: createHash("sha256").update(bytes).digest("hex"), ...(scenario.disabled
      ? { telemetryMode: "disabled-by-default", nodeDisabled: true, browserDisabled: true }
      : { telemetryMode: "sentry-live", nodeEventId: "a".repeat(32), browserEventId: "b".repeat(32) }) }));
    await writeFile(join(directory, "pack.json"), JSON.stringify([{ filename: "package.tgz", version: scenario.version }]));
    await writeFile(join(directory, "plan.json"), JSON.stringify({ ...scenario, sourceCommit: scenario.source ?? sha }));
    const result = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8", timeout: 10000,
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, GITHUB_REF: `refs/heads/${scenario.ref}`, GITHUB_SHA: sha, PI_TEST_HEAD: scenario.head ?? sha, PI_TEST_PUBLISH_RECORD: record } });
    assert.equal(result.status, scenario.succeeds ? 0 : 1, `${JSON.stringify(scenario)}: ${result.stderr}`);
    if (scenario.succeeds) assert.deepEqual(JSON.parse(await readFile(record, "utf8")), ["publish", join(directory, "package.tgz"), "--tag", scenario.tag, "--ignore-scripts"]);
    else await assert.rejects(readFile(record), { code: "ENOENT" });
  }
});
