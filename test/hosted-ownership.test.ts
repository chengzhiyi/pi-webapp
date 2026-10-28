import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile, symlink, link, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireStorageOwnership, OWNERSHIP_MARKER, withStorageLock } from "../src/host/server/plugins/hosted/storage.ts";

async function holder(root: string, name: string) {
  const child = fork(new URL("./helpers/hosted-ownership-holder.ts", import.meta.url), [root, name], {
    execArgv: ["--experimental-strip-types"], silent: true,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
  });
  child.stderr?.resume(); child.stdout?.resume();
  const closed = once(child, "close");
  const [message] = await Promise.race([once(child, "message"), closed.then(() => { throw new Error("holder exited before reply"); })]);
  return { child, message, closed };
}

for (const name of ["runtime", "transaction"] as const) for (const signal of ["SIGTERM", "SIGKILL"] as const) {
  test(`${name} kernel custody survives ${signal} without reclaiming paths or application data`, { timeout: 15000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "hosted-ownership-"));
    const owner = await holder(root, name);
    try {
      assert.equal(owner.message.owned, true);
      const code = name === "runtime" ? "runtime_owned" : "storage_busy";
      const marker = join(root, `${name}.lock`), bytes = await readFile(marker);
      assert.equal(bytes.toString(), OWNERSHIP_MARKER);
      await writeFile(join(root, "active.json"), '{"generation":7,"revision":42}');
      await writeFile(join(root, "transition.json"), '{"uncertain":"must remain"}');
      await assert.rejects(acquireStorageOwnership(root, name, 20), { code });
      const other = await holder(root, name);
      assert.equal(other.message.code, code); await other.closed;
      owner.child.kill(signal); await owner.closed;
      const release = await acquireStorageOwnership(root, name);
      try {
        await assert.rejects(acquireStorageOwnership(root, name), { code });
        assert.deepEqual(await readFile(marker), bytes, "the abandoned fence is reused without removal/replacement");
        assert.equal(await readFile(join(root, "active.json"), "utf8"), '{"generation":7,"revision":42}');
        assert.equal(await readFile(join(root, "transition.json"), "utf8"), '{"uncertain":"must remain"}');
      } finally { await release(); await release(); }
      const next = await holder(root, name); assert.equal(next.message.owned, true);
      next.child.send("release"); await next.closed;
    } finally { owner.child.kill("SIGKILL"); await owner.closed; await rm(root, { recursive: true, force: true }); }
  });
}

test("legacy PID locks (dead or live), unknown and partially written markers are not migrated online", async () => {
  const root = await mkdtemp(join(tmpdir(), "hosted-legacy-ownership-"));
  try {
    for (const name of ["runtime", "transaction"] as const) for (const bytes of [JSON.stringify({ pid: process.pid }), '{"pid":2147483647}', "{", "", '{"version":3}']) {
      const path = join(root, `${name}.lock`); await writeFile(path, bytes);
      await assert.rejects(acquireStorageOwnership(root, name), { code: name === "runtime" ? "runtime_owned" : "storage_busy" });
      assert.equal(await readFile(path, "utf8"), bytes);
      assert.equal((await readFile(join(root, `${name}.ownership.sqlite`))).length, 0, "mutex database contains no application state");
      await rm(path);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("transaction contenders yield to the event loop and serialize without lost commits", async () => {
  const root = await mkdtemp(join(tmpdir(), "hosted-transaction-custody-"));
  try {
    let count = 0;
    await Promise.all(Array.from({ length: 30 }, () => withStorageLock(root, async () => {
      const before = count; await new Promise(resolve => setTimeout(resolve, 2)); count = before + 1;
    })));
    assert.equal(count, 30);
    await assert.rejects(withStorageLock(root, async () => { throw new Error("operation failed"); }), /operation failed/);
    await withStorageLock(root, async () => {});
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a contender waits for kernel custody before reading a partially initialized marker", async t => {
  const root = await mkdtemp(join(tmpdir(), "hosted-marker-initialization-"));
  const file = await open(join(root, "probe"), "w"), prototype = Object.getPrototypeOf(file), write = prototype.writeFile;
  await file.close();
  let entered!: () => void, resume!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { resume = resolve; });
  let pause = true;
  const mock = t.mock.method(prototype, "writeFile", async function (this: unknown, ...args: unknown[]) {
    if (pause && args[0] === OWNERSHIP_MARKER) { pause = false; entered(); await gate; }
    return write.apply(this, args);
  });
  let first: Promise<void> | undefined, second: Promise<void> | undefined;
  try {
    first = withStorageLock(root, async () => {});
    await started;
    assert.equal((await readFile(join(root, "transaction.lock"))).length, 0);
    second = withStorageLock(root, async () => {});
    resume(); await Promise.all([first, second]);
    const owner = await acquireStorageOwnership(root, "runtime");
    try {
      await assert.rejects(acquireStorageOwnership(root, "runtime"), { code: "runtime_owned" });
      const other = await holder(root, "runtime");
      assert.equal(other.message.code, "runtime_owned", "closing a contended same-process connection must not release the live owner's OS lock");
      await other.closed;
      await assert.rejects(open(join(root, "runtime.lock"), "wx"), { code: "EEXIST" }, "legacy hosts are fenced while custody is live");
    } finally { await owner(); }
    await assert.rejects(readFile(join(root, "runtime.lock")), { code: "ENOENT" }, "normal release preserves old-host interoperability");
  } finally { resume(); await Promise.allSettled([first, second]); mock.mock.restore(); await rm(root, { recursive: true, force: true }); }
});

test("ownership databases reject symlinks and multiple hard links without following them", async () => {
  const root = await mkdtemp(join(tmpdir(), "hosted-unsafe-custody-"));
  try {
    const target = join(root, "outside"), path = join(root, "runtime.ownership.sqlite");
    await writeFile(target, "retained");
    await symlink(target, path);
    await assert.rejects(acquireStorageOwnership(root, "runtime"), { code: "invalid_storage" });
    await rm(path); await link(target, path);
    await assert.rejects(acquireStorageOwnership(root, "runtime"), { code: "invalid_storage" });
    assert.equal(await readFile(target, "utf8"), "retained");
  } finally { await rm(root, { recursive: true, force: true }); }
});
