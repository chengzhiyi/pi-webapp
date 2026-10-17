import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { workspaceGitControl, workspaceGitWrite, withGitWorktreeLease } from "../extension/workspace-git-write.ts";

async function repository(t: { after(fn: () => Promise<void>): void }) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-git-write-")); t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = async (...args: string[]) => (await promisify(execFile)("git", ["-c", "commit.gpgsign=false", ...args], { cwd })).stdout.trim();
  await git("init", "-b", "main"); await git("config", "user.name", "Write Test"); await git("config", "user.email", "test@example.invalid"); await git("config", "commit.gpgsign", "false");
  const state = () => workspaceGitControl(cwd);
  const write = async (operation: object) => workspaceGitWrite(cwd, { expected: (await state()).version, ...operation }, () => {});
  return { cwd, git, state, write };
}

test("stage and unstage literal files in unborn and existing repositories without changing working content", async t => {
  const { cwd, git, write } = await repository(t); const path = ":(glob)* 中文\n.txt";
  await writeFile(join(cwd, path), "first\n");
  await write({ action: "stage", path }); assert.match(await git("diff", "--cached", "--numstat"), /1\t0/);
  await write({ action: "unstage", path }); assert.equal(await git("ls-files"), ""); assert.equal(await readFile(join(cwd, path), "utf8"), "first\n");
  await write({ action: "stage", path }); await write({ action: "commit", message: "first commit\n\nDetails" });
  await writeFile(join(cwd, path), "second\n"); await write({ action: "stage", path });
  await writeFile(join(cwd, path), "third\n"); await write({ action: "unstage", path });
  assert.equal(await git("diff", "--cached"), ""); assert.equal(await readFile(join(cwd, path), "utf8"), "third\n");
});

test("commit includes only staged content, honors failing hooks, rejects stale state and empty messages", async t => {
  const { cwd, git, write, state } = await repository(t);
  await writeFile(join(cwd, "file.txt"), "staged\n"); await write({ action: "stage", path: "file.txt" });
  const stale = (await state()).version;
  await writeFile(join(cwd, "file.txt"), "unstaged\n");
  await assert.rejects(workspaceGitWrite(cwd, { action: "commit", expected: stale, message: "stale" }, () => {}), error => (error as { status: number }).status === 409);
  await assert.rejects(write({ action: "commit", message: "   " }));
  const hook = join(cwd, ".git/hooks/pre-commit"); await writeFile(hook, "#!/bin/sh\nexit 1\n"); await chmod(hook, 0o755);
  await assert.rejects(write({ action: "commit", message: "rejected" })); assert.equal((await state()).head, null);
  await rm(hook); const result = await write({ action: "commit", message: "approved\n\nBody" });
  assert.ok(result.head); assert.equal(await git("show", "HEAD:file.txt"), "staged"); assert.equal(await readFile(join(cwd, "file.txt"), "utf8"), "unstaged\n");
  await assert.rejects(write({ action: "commit", message: "nothing staged" }));
});

test("creates branches and switches only a clean root worktree, rejecting invalid, duplicate and occupied names", async t => {
  const { cwd, git, write, state } = await repository(t);
  await writeFile(join(cwd, "file.txt"), "base\n"); await write({ action: "stage", path: "file.txt" }); await write({ action: "commit", message: "base" });
  await write({ action: "create-branch", branch: "feature/中文", checkout: false }); assert.equal((await state()).branch, "main");
  await write({ action: "switch-branch", branch: "feature/中文" }); assert.equal((await state()).branch, "feature/中文");
  for (const branch of ["--force", "HEAD", "@{-1}", "a..b", "feature/中文"]) await assert.rejects(write({ action: "create-branch", branch }));
  await writeFile(join(cwd, "untracked.txt"), "keep me\n"); await assert.rejects(write({ action: "switch-branch", branch: "main" }));
  assert.equal(await readFile(join(cwd, "untracked.txt"), "utf8"), "keep me\n"); await rm(join(cwd, "untracked.txt"));
  await write({ action: "create-branch", branch: "next", checkout: true }); assert.equal((await state()).branch, "next");
  const linked = `${cwd}-linked`; t.after(() => rm(linked, { recursive: true, force: true })); await git("worktree", "add", linked, "main");
  await assert.rejects(write({ action: "switch-branch", branch: "main" }));
});

test("subdirectory writes stay scoped and root operations, symlink parents and path traversal are refused", async t => {
  const { cwd, git, write } = await repository(t); await mkdir(join(cwd, "app"));
  await writeFile(join(cwd, "outside.txt"), "outside\n"); await writeFile(join(cwd, "app/local.txt"), "local\n");
  await write({ action: "stage", path: "outside.txt" }); await write({ action: "stage", path: "app/local.txt" }); await write({ action: "commit", message: "base" });
  const scope = join(cwd, "app"); const scoped = async (operation: object) => workspaceGitWrite(scope, { expected: (await workspaceGitControl(scope)).version, ...operation }, () => {});
  await writeFile(join(scope, "local.txt"), "new local\n"); await scoped({ action: "stage", path: "local.txt" });
  assert.equal(await git("show", ":app/local.txt"), "new local");
  await assert.rejects(scoped({ action: "commit", message: "not a root workspace" }));
  await assert.rejects(scoped({ action: "stage", path: "../outside.txt" }));
  await mkdir(join(scope, "directory")); await writeFile(join(scope, "directory/file.txt"), "directory content\n");
  await assert.rejects(scoped({ action: "stage", path: "directory" }));
  await scoped({ action: "unstage", path: "local.txt" }); assert.equal(await readFile(join(scope, "local.txt"), "utf8"), "new local\n");
  await symlink(cwd, join(scope, "link")); await assert.rejects(scoped({ action: "stage", path: "link/outside.txt" }));
});

test("writes recheck the selected session and serialize against other writes and agent starts", async t => {
  const { cwd, state } = await repository(t); await writeFile(join(cwd, "file.txt"), "keep\n");
  const expected = (await state()).version;
  await assert.rejects(workspaceGitWrite(cwd, { action: "stage", path: "file.txt", expected }, () => { throw new Error("session changed"); }), /session changed/);
  let release!: () => void; let acquired!: () => void;
  const ready = new Promise<void>(yes => { acquired = yes; });
  const held = withGitWorktreeLease(cwd, async () => { acquired(); await new Promise<void>(yes => { release = yes; }); });
  await ready;
  try { await assert.rejects(workspaceGitWrite(cwd, { action: "stage", path: "file.txt", expected }, () => {}), error => (error as { status: number }).status === 409); }
  finally { release(); await held; }
});

test("deletions and renames unstage safely; lock and operation markers prevent writes", async t => {
  const { cwd, git, write, state } = await repository(t);
  await writeFile(join(cwd, "old.txt"), "base\n"); await write({ action: "stage", path: "old.txt" }); await write({ action: "commit", message: "base" });
  await git("mv", "old.txt", "new.txt"); await write({ action: "unstage", path: "new.txt" });
  assert.equal(await git("diff", "--cached"), ""); assert.equal(await readFile(join(cwd, "new.txt"), "utf8"), "base\n");
  await write({ action: "stage", path: "old.txt" }); await write({ action: "unstage", path: "old.txt" }); assert.equal(await git("diff", "--cached"), "");
  for (const [marker, reason] of [["index.lock", "index_locked"], ["MERGE_HEAD", "operation_in_progress"]]) {
    await writeFile(join(cwd, `.git/${marker}`), `${await git("rev-parse", "HEAD")}\n`);
    assert.equal((await state()).blocked, reason);
    await assert.rejects(write({ action: "stage", path: "new.txt" }), error => (error as { reason: string }).reason === reason);
    await rm(join(cwd, `.git/${marker}`));
  }
});

test("branch switching never overwrites ignored files", async t => {
  const { cwd, git, write } = await repository(t);
  await writeFile(join(cwd, ".gitignore"), "ignored.txt\n"); await write({ action: "stage", path: ".gitignore" }); await write({ action: "commit", message: "base" });
  await write({ action: "create-branch", branch: "tracked", checkout: true }); await writeFile(join(cwd, "ignored.txt"), "branch content\n"); await git("add", "-f", "ignored.txt"); await write({ action: "commit", message: "tracked" });
  await write({ action: "switch-branch", branch: "main" }); await writeFile(join(cwd, "ignored.txt"), "keep ignored content\n");
  await assert.rejects(write({ action: "switch-branch", branch: "tracked" }));
  assert.equal(await readFile(join(cwd, "ignored.txt"), "utf8"), "keep ignored content\n"); assert.equal(await git("branch", "--show-current"), "main");
});

test("optional agent discovery does not retry a failing callback and strict writes fail closed", async () => {
  const missing = join(tmpdir(), `missing-git-workspace-${Date.now()}`);
  let calls = 0;
  await assert.rejects(withGitWorktreeLease(missing, async () => { calls++; throw new Error("original agent error"); }, true), /original agent error/);
  assert.equal(calls, 1);
  await assert.rejects(withGitWorktreeLease(missing, async () => { calls++; })); assert.equal(calls, 1);
});
