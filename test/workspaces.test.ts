import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceRegistry } from "../extension/workspaces.ts";

test("workspace records use canonical directory identity and survive reload", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-workspaces-"));
  try {
    const file = join(root, "registry", "workspaces.json");
    const registry = new WorkspaceRegistry(file);
    await registry.load();
    const project = join(root, "project");
    const added = await registry.add(project, true);
    assert.equal(added.path, await realpath(project));
    const alias = join(root, "alias");
    await symlink(project, alias);
    assert.equal((await registry.add(alias)).id, added.id);
    assert.equal(registry.list().length, 1);

    const loaded = new WorkspaceRegistry(file);
    await loaded.load();
    assert.deepEqual(loaded.list(), [added]);
    await loaded.remove(added.id);
    assert.deepEqual(loaded.list(), []);
    assert.equal((await stat(project)).isDirectory(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("discovers saved Pi workspaces without restoring ones removed from the sidebar", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-discovery-"));
  try {
    const first = join(root, "first");
    const second = join(root, "second");
    await Promise.all([mkdir(first), mkdir(second)]);
    const file = join(root, "workspaces.json");
    await writeFile(file, JSON.stringify([])); // Existing registry format.
    const registry = new WorkspaceRegistry(file);
    await registry.load();
    await registry.discover([first, second]);
    assert.deepEqual(registry.list().map((item) => item.path), [await realpath(first), await realpath(second)]);
    const removed = registry.list()[1]!;
    await registry.remove(removed.id);

    const reloaded = new WorkspaceRegistry(file);
    await reloaded.load();
    await reloaded.discover([first, second]);
    assert.deepEqual(reloaded.list().map((item) => item.path), [await realpath(first)]);
    await reloaded.add(second);
    assert.deepEqual(new Set(reloaded.list().map((item) => item.path)), new Set([await realpath(first), await realpath(second)]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
