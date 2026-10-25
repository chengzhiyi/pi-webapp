import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, open, link, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicJson, boundedRead, readJson } from "../src/host/server/plugins/hosted/storage.ts";

test("atomic replacement between open and fstat retains a complete descriptor snapshot", async t => {
  const root = await mkdtemp(join(tmpdir(), "hosted-read-race-")), path = join(root, "record.json");
  const old = { revision: 1, text: "old 完整" }, next = { revision: 2, text: "new 完整" };
  await atomicJson(path, old);
  const seed = await open(path, "r"), prototype = Object.getPrototypeOf(seed), stat = prototype.stat;
  await seed.close();
  let replaced = false;
  const mock = t.mock.method(prototype, "stat", async function (this: any, ...args: any[]) {
    if (!replaced) { replaced = true; await atomicJson(path, next); }
    return stat.apply(this, args);
  });
  try {
    assert.deepEqual(await readJson(path), old, "opened inode is immutable across the atomic rename");
    assert.equal(replaced, true);
    mock.mock.restore();
    assert.deepEqual(await readJson(path), next, "next reader observes the new inode");
  } finally { mock.mock.restore(); await rm(root, { recursive: true, force: true }); }
});

test("snapshot reads still reject hard links, symlinks, directories and oversized records", async () => {
  const root = await mkdtemp(join(tmpdir(), "hosted-read-guards-"));
  try {
    const path = join(root, "record.json"); await writeFile(path, "{}");
    await link(path, join(root, "alias"));
    await assert.rejects(boundedRead(path, 10), /Invalid storage/);
    await rm(join(root, "alias"));
    await symlink(path, join(root, "symlink"));
    await assert.rejects(boundedRead(join(root, "symlink"), 10));
    await assert.rejects(boundedRead(root, 10), /Invalid storage/);
    await assert.rejects(boundedRead(path, 1), /Invalid storage/);
    assert.equal(await boundedRead(join(root, "absent"), 10), null);
    assert.equal((await boundedRead(path, 10))?.toString(), "{}");
  } finally { await rm(root, { recursive: true, force: true }); }
});
