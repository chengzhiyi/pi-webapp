import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const parentTimeout = 2000;
const helperTimeout = 350;
const skip = process.platform !== "darwin" ? "requires Darwin and the CLT"
  : process.getuid() === 0 || process.env.SUDO_UID || process.env.SUDO_USER || process.env.SUDO_COMMAND
    ? "requires a non-sudo, unprivileged user" : false;

// The actual OS parent stays alive until stdin closes. The helper inherits
// stderr, so the test can collect diagnostics even after the parent exits.
const parentScript = `
  const { spawn } = require('node:child_process');
  const [helper, ...args] = process.argv.slice(1);
  const child = spawn(helper, [String(process.pid), ...args], {
    detached: true, stdio: ['ignore', 'ignore', 'inherit'],
  });
  child.on('error', (error) => { console.error(error); process.exit(2); });
  child.unref();
  process.stdin.resume();
`;

async function identity(path) {
  const { dev, ino } = await stat(path, { bigint: true });
  return [dev.toString(), ino.toString()];
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-update-swap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const install = join(root, "Install With Spaces");
  await mkdir(install);
  const transaction = await mkdtemp(join(install, ".pi-update-"));
  const oldApp = join(install, "pi.app");
  const newApp = join(transaction, "pi.app");
  await mkdir(oldApp);
  await mkdir(newApp);
  await writeFile(join(oldApp, "version"), "old");
  await writeFile(join(newApp, "version"), "new");
  const oldId = await identity(oldApp);
  const newId = await identity(newApp);
  return { root, install, transaction, oldApp, newApp, oldId, newId, result: join(transaction, "result") };
}

function startParent(t, helper, f, install = f.install) {
  const child = spawn(process.execPath, ["-e", parentScript, helper, install, basename(f.transaction), ...f.oldId, ...f.newId], {
    stdio: ["pipe", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exit = once(child, "exit");
  const closed = once(child, "close");
  t.after(async () => {
    child.stdin.end();
    await closed;
  });
  return {
    child,
    async quit() {
      child.stdin.end();
      assert.deepEqual(await exit, [0, null], stderr);
    },
    async finished() {
      await closed;
      return stderr;
    },
  };
}

async function waitForResultFile(path) {
  for (let i = 0; i < 500; ++i) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await delay(10);
  }
  assert.fail("helper did not reserve result");
}

async function assertBundles(f, swapped = false) {
  assert.deepEqual(await identity(f.oldApp), swapped ? f.newId : f.oldId);
  assert.deepEqual(await identity(f.newApp), swapped ? f.oldId : f.newId);
  assert.equal(await readFile(join(f.oldApp, "version"), "utf8"), swapped ? "new" : "old");
  assert.equal(await readFile(join(f.newApp, "version"), "utf8"), swapped ? "old" : "new");
}

describe("Darwin update-swap", { skip }, () => {
  let build;
  let helper;

  before(async () => {
    build = await mkdtemp(join(tmpdir(), "pi-update-swap-build-"));
    helper = join(build, "update-swap");
    execFileSync("/usr/bin/xcrun", ["clang", "-std=c11", "-Wall", "-Wextra", "-Werror",
      `-DUPDATE_SWAP_PARENT_TIMEOUT_MS=${parentTimeout}`, `-DUPDATE_SWAP_HELPER_TIMEOUT_MS=${helperTimeout}`,
      fileURLToPath(new URL("../update-swap.c", import.meta.url)), "-o", helper]);
  });

  after(async () => {
    if (build) await rm(build, { recursive: true, force: true });
  });

  test("waits for the spawning parent to quit, then exchanges the bundles and leaves the backup", async (t) => {
    const f = await fixture(t);
    const parent = startParent(t, helper, f);
    assert.equal(await waitForResultFile(f.result), "");
    await delay(120); // Several helper polls while the parent is still alive.
    assert.equal(await readFile(f.result, "utf8"), "");
    await assertBundles(f);
    await parent.quit();
    const stderr = await parent.finished();
    assert.equal(await readFile(f.result, "utf8"), "installed\n", stderr);
    await assertBundles(f, true);
  });

  test("defers when the parent outlives the wait", async (t) => {
    const f = await fixture(t);
    const parent = startParent(t, helper, f);
    assert.equal(await waitForResultFile(f.result), "");
    await delay(parentTimeout);
    // The parent's pipe keeps the close event pending, even after the helper exits.
    let result;
    for (let i = 0; i < 100 && !result; ++i) {
      result = await readFile(f.result, "utf8");
      if (!result) await delay(10);
    }
    assert.equal(result, "deferred\n");
    assert.equal(parent.child.exitCode, null);
    await assertBundles(f);
    await parent.quit();
  });

  test("rejects a staged inode replaced while the parent was alive", async (t) => {
    const f = await fixture(t);
    const parent = startParent(t, helper, f);
    assert.equal(await waitForResultFile(f.result), "");
    const displaced = join(f.transaction, "displaced.app");
    await rename(f.newApp, displaced);
    await mkdir(f.newApp);
    const replacement = await identity(f.newApp);
    await parent.quit();
    assert.match(await parent.finished(), /bundle identity/);
    assert.equal(await readFile(f.result, "utf8"), "deferred\n");
    assert.deepEqual(await identity(f.oldApp), f.oldId);
    assert.deepEqual(await identity(f.newApp), replacement);
    assert.deepEqual(await identity(displaced), f.newId);
  });

  test("defers while a bundled executable is still running", async (t) => {
    const f = await fixture(t);
    const runtime = join(f.oldApp, "Contents", "Resources", "runtime");
    await mkdir(runtime, { recursive: true });
    const executable = join(runtime, "worker");
    execFileSync("/usr/bin/xcrun", ["clang", "-x", "c", "-", "-o", executable], {
      input: `#include <unistd.h>\nint main(void) { char c; if (write(1, "ready\\n", 6) != 6) return 1; return read(0, &c, 1) < 0; }`,
    });
    const worker = spawn(executable, [], { stdio: ["pipe", "pipe", "inherit"] });
    const workerExited = once(worker, "exit");
    t.after(async () => {
      worker.stdin.end();
      await workerExited;
    });
    const [ready] = await Promise.race([
      once(worker.stdout, "data"),
      workerExited.then(() => assert.fail("bundled worker exited before readiness")),
    ]);
    assert.equal(ready.toString(), "ready\n");
    const parent = startParent(t, helper, f);
    assert.equal(await waitForResultFile(f.result), "");
    await parent.quit();
    assert.match(await parent.finished(), /installed bundle is still in use/);
    assert.equal(await readFile(f.result, "utf8"), "deferred\n");
    assert.equal(worker.exitCode, null);
    await assertBundles(f);
  });

  test("does not exchange bundles when result already exists", async (t) => {
    const f = await fixture(t);
    await writeFile(f.result, "leave me alone\n");
    const parent = startParent(t, helper, f);
    await parent.quit();
    assert.match(await parent.finished(), /create result/);
    assert.equal(await readFile(f.result, "utf8"), "leave me alone\n");
    await assertBundles(f);
  });

  test("refuses a transaction with non-private permissions", async (t) => {
    const f = await fixture(t);
    await chmod(f.transaction, 0o755);
    const parent = startParent(t, helper, f);
    await parent.quit();
    assert.match(await parent.finished(), /transaction must be a private directory/);
    await assert.rejects(readFile(f.result), { code: "ENOENT" });
    await assertBundles(f);
  });

  test("does not follow a symlink in place of the install directory", async (t) => {
    const f = await fixture(t);
    const link = join(f.root, "install link");
    await symlink(f.install, link);
    const parent = startParent(t, helper, f, `${link}/`);
    await parent.quit();
    assert.match(await parent.finished(), /open install directory/);
    await assert.rejects(readFile(f.result), { code: "ENOENT" });
    await assertBundles(f);
  });
});
