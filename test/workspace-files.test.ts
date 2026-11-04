import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EDITOR_LIMITS, listWorkspaceFiles, previewWorkspaceFile, writeWorkspaceFile } from "../src/plugins/builtin/files/server/workspace-files.ts";
import { searchWorkspaceFiles, workspaceFileStatus } from "../src/plugins/builtin/files/server/workspace-search.ts";

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
    // The Files editor opens what Git's line-by-line diffs (the default limits) refuse.
    assert.equal((await previewWorkspaceFile(root, "big.txt", EDITOR_LIMITS)).kind, "text");
    assert.equal((await previewWorkspaceFile(root, "many-lines.txt", EDITOR_LIMITS)).kind, "text");
    await writeFile(join(root, "huge.txt"), Buffer.alloc(6 * 1024 * 1024, 65));
    assert.equal((await previewWorkspaceFile(root, "huge.txt", EDITOR_LIMITS)).kind, "too-large");
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

async function versionOf(root: string, path: string): Promise<string> {
  const preview = await previewWorkspaceFile(root, path);
  assert.equal(preview.kind, "text");
  return preview.kind === "text" ? preview.version : "";
}

test("saves overwrite an existing text file in place only from the version on disk", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-files-write-"));
  try {
    await mkdir(join(root, "project"));
    const workspace = join(root, "project");
    await writeFile(join(workspace, "a.txt"), "one\n");
    await chmod(join(workspace, "a.txt"), 0o640);
    const version = await versionOf(workspace, "a.txt");
    const saved = await writeWorkspaceFile(workspace, "a.txt", "two\n", version);
    assert.equal(await readFile(join(workspace, "a.txt"), "utf8"), "two\n");
    assert.equal(saved.version, await versionOf(workspace, "a.txt"));
    assert.equal((await stat(join(workspace, "a.txt"))).mode & 0o777, 0o640);
    // The old version is now stale: a second save from it is a conflict and changes nothing.
    await assert.rejects(writeWorkspaceFile(workspace, "a.txt", "three\n", version), (error: { status: number; reason: string }) => error.status === 409 && error.reason === "conflict");
    assert.equal(await readFile(join(workspace, "a.txt"), "utf8"), "two\n");
    // Saves never create files, follow links out of the workspace or accept bad input.
    await writeFile(join(root, "outside.txt"), "private");
    await symlink(join(root, "outside.txt"), join(workspace, "link.txt"));
    const outside = (await import("node:crypto")).createHash("sha256").update("private").digest("hex");
    for (const path of ["missing.txt", "../outside.txt", join(root, "outside.txt"), "link.txt", ""]) await assert.rejects(writeWorkspaceFile(workspace, path, "x", outside));
    assert.equal(await readFile(join(root, "outside.txt"), "utf8"), "private");
    await assert.rejects(writeWorkspaceFile(workspace, "a.txt", 42, saved.version));
    await assert.rejects(writeWorkspaceFile(workspace, "a.txt", "x", "not-a-version"));
    await assert.rejects(writeWorkspaceFile(workspace, "a.txt", "x".repeat(6 * 1024 * 1024), saved.version), (error: { status: number }) => error.status === 413);
    assert.equal(await readFile(join(workspace, "a.txt"), "utf8"), "two\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("status reports changed, untracked and ignored paths relative to the workspace, and hides .git", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-files-status-"));
  try {
    const run = (...args: string[]) => execFileSync("git", args, { cwd: root });
    await mkdir(join(root, "app", "src"), { recursive: true });
    await writeFile(join(root, "app", ".gitignore"), "build/\n");
    await writeFile(join(root, "app", "src", "kept.ts"), "1\n");
    await writeFile(join(root, "app", "src", "gone.ts"), "1\n");
    await writeFile(join(root, "outside.ts"), "1\n");
    run("init", "-q"); run("add", "."); run("-c", "user.email=a@example.com", "-c", "user.name=A", "commit", "-qm", "init");
    await writeFile(join(root, "app", "src", "kept.ts"), "2\n");
    await rm(join(root, "app", "src", "gone.ts"));
    await mkdir(join(root, "app", "build")); await writeFile(join(root, "app", "build", "out.js"), "");
    await mkdir(join(root, "app", "fresh")); await writeFile(join(root, "app", "fresh", "new.ts"), "");
    await writeFile(join(root, "outside.ts"), "2\n");
    const status = await workspaceFileStatus(join(root, "app"));
    assert.equal(status.kind, "repository");
    assert.deepEqual(status.entries.map(({ path, state }) => `${state}:${path}`).sort(), ["deleted:src/gone.ts", "ignored:build/", "modified:src/kept.ts", "untracked:fresh/"]);
    assert.deepEqual((await listWorkspaceFiles(root, "")).entries.map(entry => entry.name).includes(".git"), false);
    const plain = await mkdtemp(join(tmpdir(), "pi-files-plain-"));
    try { assert.deepEqual(await workspaceFileStatus(plain), { kind: "not-repository", entries: [], truncated: false }); }
    finally { await rm(plain, { recursive: true, force: true }); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("search ranks names and finds text, respecting .gitignore in repositories and skipping node_modules outside them", async () => {
  for (const repository of [true, false]) {
    const root = await mkdtemp(join(tmpdir(), "pi-files-search-"));
    try {
      await mkdir(join(root, "src", "deep"), { recursive: true });
      await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
      await mkdir(join(root, "build"));
      await writeFile(join(root, "src", "button.tsx"), "export const Button = 'Find Me';\n");
      await writeFile(join(root, "src", "deep", "big-button-helper.ts"), "// nothing here\n");
      await writeFile(join(root, "node_modules", "pkg", "button.js"), "find me\n");
      await writeFile(join(root, "build", "button.js"), "find me\n");
      await writeFile(join(root, "binary.bin"), Buffer.from([0, 102, 105, 110, 100, 32, 109, 101]));
      await writeFile(join(root, ".gitignore"), "node_modules/\nbuild/\n");
      if (repository) execFileSync("git", ["init", "-q"], { cwd: root });
      const names = await searchWorkspaceFiles(root, "button", "name");
      assert.equal(names.kind, "name");
      const paths = names.results.map(result => result.path);
      assert.equal(paths[0], "src/button.tsx");
      assert.ok(paths.includes("src/deep/big-button-helper.ts"));
      assert.ok(!paths.some(path => path.startsWith("node_modules/")));
      assert.equal(paths.some(path => path.startsWith("build/")), !repository, "build/ is ignored only by Git");
      assert.deepEqual((await searchWorkspaceFiles(root, "btx", "name")).results.map(result => result.path), ["src/button.tsx"]);
      const content = await searchWorkspaceFiles(root, "FIND me", "content");
      assert.equal(content.kind, "content");
      assert.deepEqual(content.results.filter(hit => !hit.path.startsWith("build/")), [{ path: "src/button.tsx", line: 1, text: "export const Button = 'Find Me';" }]);
      await assert.rejects(searchWorkspaceFiles(root, "", "name"));
      await assert.rejects(searchWorkspaceFiles(root, "x", "regex"));
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
