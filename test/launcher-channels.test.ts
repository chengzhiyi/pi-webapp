import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("cold npm launches retain alpha and explicit stable selections, but ignore obsolete downgrade overrides", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-cold-channel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(new URL("../bin/", import.meta.url), join(root, "bin"), { recursive: true });
  await mkdir(join(root, "desktop"));
  await cp(new URL("../desktop/managed-release.mjs", import.meta.url), join(root, "desktop", "managed-release.mjs"));
  await cp(new URL("../desktop/release-version.mjs", import.meta.url), join(root, "desktop", "release-version.mjs"));
  await cp(new URL("../desktop/stop-outcome.mjs", import.meta.url), join(root, "desktop", "stop-outcome.mjs"));
  await cp(new URL("../desktop/launcher-handoff.mjs", import.meta.url), join(root, "desktop", "launcher-handoff.mjs"));
  await symlink(resolve("node_modules"), join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "pi-webapp", version: "0.2.0-alpha.1" }));
  const agentDir = join(root, "agent");
  await mkdir(join(agentDir, "pi-web"), { recursive: true });
  const record = join(root, "launched.json"); const next = join(root, "selected.mjs");
  await writeFile(next, 'import { writeFileSync } from "node:fs"; writeFileSync(process.env.PI_TEST_CHANNEL_RECORD, JSON.stringify(process.argv.slice(2)));');
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_TEST_CHANNEL_RECORD: record, PI_WEBAPP_RUNTIME: "npm", PI_WEBAPP_RESTART_PORT: undefined, PI_WEBAPP_RESTART_TOKEN: undefined };
  for (const selection of [
    { version: "0.2.0-alpha.10", accepted: true },
    { version: "0.1.29", baseVersion: "0.2.0-alpha.1", allowDowngrade: true, accepted: true },
    { version: "0.1.29", accepted: false },
    { version: "0.1.29", baseVersion: "0.1.28", allowDowngrade: true, accepted: false },
  ]) {
    await rm(record, { force: true });
    await writeFile(join(agentDir, "pi-web", "update.json"), JSON.stringify({ ...selection, launcher: next }));
    const result = spawnSync(process.execPath, [join(root, "bin", "pi-webapp.mjs"), "start"], { env, encoding: "utf8", timeout: 10000 });
    if (selection.accepted) {
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(await readFile(record, "utf8")), ["start"]);
    } else {
      // No dist/extension.js in this fixture: rejecting the managed selection
      // must stop before probing/installing a real Pi or starting any service.
      assert.equal(result.status, 1); assert.match(result.stderr, /找不到构建后的扩展/);
      await assert.rejects(readFile(record));
    }
  }
});
