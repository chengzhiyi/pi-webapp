import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { workspaceGitStatus, workspaceGitDiff } from "../extension/workspace-git.ts";

const execute = promisify(execFile);
async function repository(t: { after(fn: () => Promise<void>): void }) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-git-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = (...args: string[]) => execute("git", ["-c", "user.name=Git Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd });
  await git("init", "-b", "main");
  return { cwd, git };
}

test("Git status distinguishes staged, unstaged and untracked files, and reads each side without writing", async t => {
  const { cwd, git } = await repository(t);
  await writeFile(join(cwd, "main.ts"), "const value = 1;\n");
  await git("add", "."); await git("commit", "-m", "initial");
  await writeFile(join(cwd, "main.ts"), "const value = 2;\n"); await git("add", "main.ts");
  await writeFile(join(cwd, "main.ts"), "const value = 3;\n");
  const special = "中文 file\n[name].txt";
  await writeFile(join(cwd, special), "new file\n");
  const indexBefore = await readFile(join(cwd, ".git/index"));
  const status = await workspaceGitStatus(cwd);
  assert.equal(status.kind, "repository");
  if (status.kind !== "repository") return;
  assert.equal(status.branch, "main");
  assert.equal(status.scope, "");
  assert.deepEqual(status.entries.find(entry => entry.path === "main.ts"), { path: "main.ts", index: "M", worktree: "M", conflict: false, untracked: false, submodule: false });
  assert.equal(status.entries.find(entry => entry.path === special)?.untracked, true);
  const staged = await workspaceGitDiff(cwd, "main.ts", "staged");
  const unstaged = await workspaceGitDiff(cwd, "main.ts", "unstaged");
  assert.equal(staged.kind, "text"); assert.equal(unstaged.kind, "text");
  if (staged.kind === "text" && unstaged.kind === "text") {
    assert.match(staged.patch, /-const value = 1;\n\+const value = 2;/);
    assert.match(unstaged.patch, /-const value = 2;\n\+const value = 3;/);
  }
  const added = await workspaceGitDiff(cwd, special, "untracked");
  assert.equal(added.kind, "text"); if (added.kind === "text") assert.match(added.patch, /\+new file/);
  assert.deepEqual(await readFile(join(cwd, ".git/index")), indexBefore);
  assert.equal(await readFile(join(cwd, "main.ts"), "utf8"), "const value = 3;\n");
});

test("Git handles non-repositories, unborn and detached HEAD, and linked worktrees", async t => {
  const { cwd, git } = await repository(t);
  const outside = await mkdtemp(join(tmpdir(), "pi-no-git-")); t.after(() => rm(outside, { recursive: true, force: true }));
  assert.equal((await workspaceGitStatus(outside)).kind, "not-repository");
  await writeFile(join(cwd, "new.txt"), "initial\n"); await git("add", ".");
  const unborn = await workspaceGitStatus(cwd);
  assert.equal(unborn.kind === "repository" && unborn.head, null);
  assert.equal((await workspaceGitDiff(cwd, "new.txt", "staged")).kind, "text");
  await git("commit", "-m", "initial");
  const worktree = join(outside, "linked"); await git("worktree", "add", "--detach", worktree);
  const linked = await workspaceGitStatus(worktree);
  assert.equal(linked.kind, "repository");
  if (linked.kind === "repository") { assert.equal(linked.branch, null); assert.ok(linked.head); assert.equal(linked.root, await realpath(worktree)); }
});

test("Git scopes subdirectory workspaces and never exposes renamed source content outside them", async t => {
  const { cwd, git } = await repository(t);
  await mkdir(join(cwd, "app"));
  await writeFile(join(cwd, "secret.txt"), "PRIVATE OUTSIDE\n");
  await writeFile(join(cwd, "app", "local.txt"), "local\n");
  await git("add", "."); await git("commit", "-m", "initial");
  await git("mv", "secret.txt", "app/moved.txt");
  await writeFile(join(cwd, "other.txt"), "outside untracked\n");
  const scope = join(cwd, "app");
  const status = await workspaceGitStatus(scope);
  assert.equal(status.kind, "repository");
  if (status.kind === "repository") {
    assert.equal(status.scope, "app/");
    assert.deepEqual(status.entries.map(entry => entry.path), ["moved.txt"]);
    assert.equal(status.entries[0]!.originalPath, undefined);
  }
  await assert.rejects(workspaceGitDiff(scope, "../secret.txt", "staged"), /工作区/);
  assert.equal((await workspaceGitDiff(scope, ":(glob)**", "staged")).kind, "empty");
  // The renamed destination is shown as an addition, never as a comparison to an out-of-scope source.
  const diff = await workspaceGitDiff(scope, "moved.txt", "staged");
  assert.equal(diff.kind, "text"); if (diff.kind === "text") assert.doesNotMatch(diff.patch, /a\/secret\.txt|^-PRIVATE/m);
});

test("Git diffs handle renames, deletions, binary and large files and refuse external symlinks", async t => {
  const { cwd, git } = await repository(t);
  await writeFile(join(cwd, "old.txt"), "before\n");
  await writeFile(join(cwd, "deleted.txt"), "removed\n");
  await git("add", "."); await git("commit", "-m", "initial");
  await git("mv", "old.txt", "renamed.txt"); await rm(join(cwd, "deleted.txt"));
  await writeFile(join(cwd, "binary.bin"), Buffer.from([0, 255]));
  await writeFile(join(cwd, "large.txt"), "x".repeat(600 * 1024));
  await symlink("/etc/passwd", join(cwd, "link"));
  const status = await workspaceGitStatus(cwd);
  assert.equal(status.kind === "repository" && status.entries.find(entry => entry.path === "renamed.txt")?.originalPath, "old.txt");
  const removed = await workspaceGitDiff(cwd, "deleted.txt", "unstaged");
  assert.equal(removed.kind, "text"); if (removed.kind === "text") assert.match(removed.patch, /-removed/);
  assert.equal((await workspaceGitDiff(cwd, "binary.bin", "untracked")).kind, "binary");
  assert.equal((await workspaceGitDiff(cwd, "large.txt", "untracked")).kind, "too-large");
  assert.equal((await workspaceGitDiff(cwd, "link", "untracked")).kind, "unsupported");
  assert.equal((await workspaceGitDiff(cwd, "old.txt", "staged")).kind, "empty");
});

test("Git reports upstream divergence and unresolved merge conflicts", async t => {
  const { cwd, git } = await repository(t);
  await writeFile(join(cwd, "conflict.txt"), "base\n"); await git("add", "."); await git("commit", "-m", "base");
  await git("branch", "upstream"); await git("branch", "--set-upstream-to=upstream");
  await writeFile(join(cwd, "conflict.txt"), "main\n"); await git("commit", "-am", "main");
  const ahead = await workspaceGitStatus(cwd);
  assert.equal(ahead.kind === "repository" && ahead.upstream, "upstream");
  assert.equal(ahead.kind === "repository" && ahead.ahead, 1);
  assert.equal(ahead.kind === "repository" && ahead.behind, 0);
  await git("switch", "upstream"); await writeFile(join(cwd, "conflict.txt"), "other\n"); await git("commit", "-am", "other");
  await git("switch", "main"); await assert.rejects(git("merge", "upstream"));
  const conflict = await workspaceGitStatus(cwd);
  assert.equal(conflict.kind === "repository" && conflict.entries[0]?.conflict, true);
  assert.equal((await workspaceGitDiff(cwd, "conflict.txt", "unstaged")).kind, "conflict");
});

test("Git disables external diff and textconv and treats pathspec-like filenames literally", async t => {
  const { cwd, git } = await repository(t);
  const filename = ":(glob)*.txt";
  await writeFile(join(cwd, filename), "before\n");
  await writeFile(join(cwd, ".gitattributes"), "*.txt diff=custom\n");
  await git("add", "."); await git("commit", "-m", "base");
  await git("config", "diff.custom.command", "false");
  await git("config", "diff.custom.textconv", "false");
  await writeFile(join(cwd, filename), "after\n");
  const result = await workspaceGitDiff(cwd, filename, "unstaged");
  assert.equal(result.kind, "text"); if (result.kind === "text") assert.match(result.patch, /\+after/);
});

test("Git bounds file listings and tracked patches instead of rendering partial output", async t => {
  const { cwd, git } = await repository(t);
  await writeFile(join(cwd, "tracked.txt"), "initial\n"); await git("add", "."); await git("commit", "-m", "base");
  await writeFile(join(cwd, "tracked.txt"), "x".repeat(600 * 1024));
  assert.equal((await workspaceGitDiff(cwd, "tracked.txt", "unstaged")).kind, "too-large");
  await writeFile(join(cwd, "tracked.txt"), "line\n".repeat(11000));
  assert.equal((await workspaceGitDiff(cwd, "tracked.txt", "unstaged")).kind, "too-large");
  await Promise.all(Array.from({ length: 1001 }, (_, index) => writeFile(join(cwd, `file-${index}.txt`), "")));
  const status = await workspaceGitStatus(cwd);
  assert.equal(status.kind, "repository");
  if (status.kind === "repository") { assert.equal(status.entries.length, 1000); assert.equal(status.truncated, true); }
});

test("Git ignores inherited repository redirection and reports a missing Git executable", async t => {
  const { cwd } = await repository(t);
  const previousDirectory = process.env.GIT_DIR;
  const previousPath = process.env.PATH;
  try {
    process.env.GIT_DIR = "/no-such-repository";
    assert.equal((await workspaceGitStatus(cwd)).kind, "repository");
    process.env.PATH = "/no-such-binaries";
    assert.equal((await workspaceGitStatus(cwd)).kind, "unavailable");
  } finally {
    if (previousDirectory === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previousDirectory;
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
  }
});

test("Git never reads outside content when a tracked parent directory is replaced by a symlink", async t => {
  const { cwd, git } = await repository(t);
  await mkdir(join(cwd, "folder")); await writeFile(join(cwd, "folder/file.txt"), "inside content\n");
  await git("add", "."); await git("commit", "-m", "base");
  const outside = await mkdtemp(join(tmpdir(), "pi-git-outside-")); t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "file.txt"), "PRIVATE OUTSIDE CONTENT\n");
  await rm(join(cwd, "folder"), { recursive: true }); await symlink(outside, join(cwd, "folder"));
  const result = await workspaceGitDiff(cwd, "folder/file.txt", "unstaged");
  assert.equal(result.kind, "text"); if (result.kind === "text") assert.doesNotMatch(result.patch, /PRIVATE OUTSIDE/);
});
