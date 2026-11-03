import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DesktopBackend, alive } from "../backend.mjs";
import { desktopUpdatePath, writeDesktopRelease } from "../managed-release.mjs";
import { resetUpgradeState, upgradeStateFiles } from "../reset-upgrade.mjs";
import { fakePi, stageRuntime } from "./fixtures/runtime.mjs";

const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
const launcher = fileURLToPath(new URL("../../bin/pi-webapp.mjs", import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-reset-upgrade "));
  const piCli = join(root, "fake-pi.mjs");
  await writeFile(piCli, fakePi);
  const options = { agentDir: root, version: pkg.version, node: process.execPath, piCli, launcher, npmCli: "unused", cwd: root, isAlive: alive,
    env: { ...process.env, PI_CODING_AGENT_DIR: root, PI_WEBAPP_RESTART_PORT: undefined, PI_WEBAPP_RESTART_TOKEN: undefined, PI_WEB_SENTRY_ENABLED: "false" }, timeoutMs: 10000 };
  const backend = new DesktopBackend(options);
  t.after(async () => { await backend.stop({ force: true }).catch(() => {}); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return { root, backend, options };
}
/** The state that wedged 0.1.50: a stuck pair journal, a stale candidate and a restart marker. */
async function stuckState(root) {
  await mkdir(join(root, "pi-web/hosted/host-pair"), { recursive: true });
  await mkdir(join(root, "pi-web/upgrade"), { recursive: true });
  await mkdir(join(root, "pi-web/hosted/data/plugin"), { recursive: true });
  const journal = JSON.stringify({ schema: 1, phase: "required-action", message: "plugin startup failed (not_installed)" });
  await writeFile(join(root, "pi-web/hosted/host-pair/intent.json"), journal);
  await writeFile(join(root, "pi-web/upgrade/candidate.json"), "{\"schema\":1}");
  await writeFile(join(root, "pi-web/update-transaction.json"), "{\"phase\":\"failed\"}");
  await writeFile(join(root, "pi-web/hosted/data/plugin/drawing.json"), "user data");
  return journal;
}

test("reset moves every upgrade record aside with a receipt and never deletes or touches user data", async t => {
  const { root } = await fixture(t), journal = await stuckState(root);
  for (const name of ["launcher.restart", "desktop-update.json", "desktop-handoff.json", "launcher-handoff.json", "upgrade/transaction.json"]) await writeFile(join(root, "pi-web", name), name);
  const now = new Date("2026-11-02T08:00:00.000Z");
  const result = await resetUpgradeState(root, now);
  assert.deepEqual([...result.moved].sort(), [...upgradeStateFiles].sort());
  for (const relative of upgradeStateFiles) await assert.rejects(readFile(join(root, "pi-web", relative)), { code: "ENOENT" }, relative);
  assert.equal(await readFile(join(result.folder, "hosted__host-pair__intent.json"), "utf8"), journal, "bytes are kept for diagnosis");
  assert.deepEqual(JSON.parse(await readFile(join(result.folder, "receipt.json"), "utf8")).moved, result.moved);
  assert.equal(await readFile(join(root, "pi-web/hosted/data/plugin/drawing.json"), "utf8"), "user data");
  assert.deepEqual(await resetUpgradeState(root, new Date()), { folder: null, moved: [] }, "a second reset is a no-op");
});

test("the shell escape route stops its backend, clears a wedged update and starts the bundled version", async t => {
  const { root, backend } = await fixture(t);
  const release = await stageRuntime(root, "9.0.0");
  await writeDesktopRelease(root, release);
  assert.equal((await backend.connect()).version, "9.0.0");
  const journal = await stuckState(root);
  const result = await backend.resetUpgrade();
  assert.equal(result.state.version, pkg.version, "now running the shell's bundled package");
  assert.equal(backend.owned, true);
  await assert.rejects(readFile(desktopUpdatePath(root)), { code: "ENOENT" });
  assert.ok(result.moved.includes("desktop-update.json") && result.moved.includes("hosted/host-pair/intent.json"));
  assert.equal(await readFile(join(result.folder, "hosted__host-pair__intent.json"), "utf8"), journal);
  assert.equal(await readFile(join(root, "pi-web/hosted/data/plugin/drawing.json"), "utf8"), "user data");
  assert.deepEqual((await readdir(join(root, "pi-web/releases"))).length > 0, true, "the downloaded release is kept");
});

test("the escape route never stops a backend this shell does not own", async t => {
  const { root, backend, options } = await fixture(t);
  const owner = await backend.connect();
  await stuckState(root);
  const other = new DesktopBackend({ ...options, spawnProcess: () => assert.fail("must not start a second backend") });
  assert.equal((await other.connect()).pid, owner.pid); assert.equal(other.owned, false);
  await assert.rejects(other.resetUpgrade(), /Another backend|另一个后台/);
  assert.ok(await readFile(join(root, "pi-web/hosted/host-pair/intent.json"), "utf8"), "nothing was moved");
  assert.equal((await backend.readState()).pid, owner.pid, "the shared backend keeps running");
});
