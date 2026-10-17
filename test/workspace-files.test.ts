import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listWorkspaceFiles, previewWorkspaceFile } from "../extension/workspace-files.ts";

test("workspace tree includes dotfiles and files, sorts directories first and lists only one level", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-files-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "main.ts"), "export const value = 1;\n");
    await writeFile(join(root, ".gitignore"), "node_modules\n");
    await writeFile(join(root, "file10.txt"), "ten");
    await writeFile(join(root, "file2.txt"), "two");
    const listing = await listWorkspaceFiles(root, "");
    assert.deepEqual(listing.entries.map(entry => [entry.path, entry.kind]), [
      ["src", "directory"], [".gitignore", "file"], ["file2.txt", "file"], ["file10.txt", "file"],
    ]);
    assert.equal(listing.truncated, false);
    assert.deepEqual((await listWorkspaceFiles(root, "src")).entries.map(entry => entry.path), ["src/main.ts"]);
    const preview = await previewWorkspaceFile(root, "src/main.ts");
    assert.equal(preview.kind, "text");
    if (preview.kind === "text") assert.equal(preview.text, "export const value = 1;\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("workspace reads reject traversal, absolute paths, symlink escapes and non-files", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-files-"));
  const workspace = join(root, "project");
  try {
    await mkdir(workspace);
    await mkdir(join(root, "outside"));
    await writeFile(join(root, "outside", "secret.txt"), "private");
    await writeFile(join(workspace, "ok.txt"), "okay");
    await symlink(join(root, "outside"), join(workspace, "escape"), "dir");
    await symlink(join(root, "outside", "secret.txt"), join(workspace, "secret.txt"), "file");
    await symlink(join(workspace, "ok.txt"), join(workspace, "alias.txt"), "file");
    for (const path of ["../outside/secret.txt", join(root, "outside", "secret.txt"), "C:\\outside\\secret.txt", "escape/secret.txt", "secret.txt", "ok.txt\0"]) {
      await assert.rejects(previewWorkspaceFile(workspace, path));
    }
    await assert.rejects(listWorkspaceFiles(workspace, "escape"));
    await assert.rejects(previewWorkspaceFile(workspace, ""));
    await assert.rejects(previewWorkspaceFile(workspace, "missing.txt"));
    const listing = await listWorkspaceFiles(workspace, "");
    assert.equal(listing.entries.find(entry => entry.name === "escape")?.kind, "other");
    assert.equal((await previewWorkspaceFile(workspace, "alias.txt")).kind, "text");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("previews handle empty, UTF-8, active markup, binary, image and oversized files without executing content", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-files-"));
  try {
    for (const [name, text] of [["empty.txt", ""], ["notes.md", "# 中文\n"], ["page.html", "<script>alert(1)</script>"], ["icon.svg", '<svg onload="alert(1)"/>']]) {
      await writeFile(join(root, name!), text!);
      const preview = await previewWorkspaceFile(root, name!);
      assert.equal(preview.kind, "text");
      if (preview.kind === "text") assert.equal(preview.text, text);
    }
    await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2, 255]));
    assert.equal((await previewWorkspaceFile(root, "binary.bin")).kind, "unsupported");
    await writeFile(join(root, "not-utf8.txt"), Buffer.from([0xff, 0xfe, 0x80]));
    assert.equal((await previewWorkspaceFile(root, "not-utf8.txt")).kind, "unsupported");
    await writeFile(join(root, "big.txt"), Buffer.alloc(1024 * 1024, 65));
    assert.equal((await previewWorkspaceFile(root, "big.txt")).kind, "too-large");
    await writeFile(join(root, "many-lines.txt"), "\n".repeat(20000));
    const manyLines = await previewWorkspaceFile(root, "many-lines.txt");
    assert.equal(manyLines.kind, "too-large");
    if (manyLines.kind === "too-large") assert.equal(manyLines.unit, "lines");
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
    await writeFile(join(root, "image.png"), Buffer.from(png, "base64"));
    const image = await previewWorkspaceFile(root, "image.png");
    assert.equal(image.kind, "image");
    if (image.kind === "image") { assert.equal(image.mimeType, "image/png"); assert.equal(image.data, png); }
    await writeFile(join(root, "fake.png"), "<script>alert(1)</script>");
    assert.notEqual((await previewWorkspaceFile(root, "fake.png")).kind, "image");
    await Promise.all(Array.from({ length: 1002 }, (_, index) => writeFile(join(root, `entry-${index}`), "")));
    const listing = await listWorkspaceFiles(root, "");
    assert.equal(listing.entries.length, 1000);
    assert.equal(listing.truncated, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
