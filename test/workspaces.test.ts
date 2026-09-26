import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, rm, stat, symlink } from "node:fs/promises";
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
