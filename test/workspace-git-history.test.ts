import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { workspaceGitHistory, workspaceGitCommit, workspaceGitCommitDiff } from "../extension/workspace-git-history.ts";

async function repository(t: { after(fn: () => Promise<void>): void }) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-history-")); t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = async (...args: string[]) => (await promisify(execFile)("git", ["-c", "user.name=History Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd })).stdout.trim();
  await git("init", "-b", "main");
  return { cwd, git };
}

test("history preserves merge parents and refs, paginates without duplicates and invalidates stale cursors", async t => {
  const { cwd, git } = await repository(t);
  assert.deepEqual((await workspaceGitHistory(cwd)).commits, []);
  await writeFile(join(cwd, "base.txt"), "base\n"); await git("add", "."); await git("commit", "-m", "initial");
  const root = await git("rev-parse", "HEAD");
  await git("switch", "-c", "feature"); await writeFile(join(cwd, "feature.txt"), "feature\n"); await git("add", "."); await git("commit", "-m", "功能提交");
  const feature = await git("rev-parse", "HEAD"); await git("tag", "-a", "v1", "-m", "release");
  await git("switch", "main"); await writeFile(join(cwd, "main.txt"), "main\n"); await git("add", "."); await git("commit", "-m", "main change");
  const main = await git("rev-parse", "HEAD"); await git("merge", "--no-ff", "feature", "-m", "merge feature");
  const merge = await git("rev-parse", "HEAD");
  const first = await workspaceGitHistory(cwd, { limit: 2 });
  assert.equal(first.commits[0]?.hash, merge); assert.deepEqual(first.commits[0]?.parents, [main, feature]); assert.ok(first.nextCursor);
  const second = await workspaceGitHistory(cwd, { limit: 2, cursor: first.nextCursor! });
  assert.equal(first.snapshot, second.snapshot);
  const commits = [...first.commits, ...second.commits];
  assert.equal(new Set(commits.map(commit => commit.hash)).size, 4); assert.equal(second.nextCursor, null);
  assert.equal(commits.at(-1)?.hash, root);
  assert.ok(first.refs.some(ref => ref.name === "v1" && ref.hash === feature && ref.kind === "tag"));
  assert.equal(first.head, merge);
  await git("tag", "new-ref");
  await assert.rejects(workspaceGitHistory(cwd, { cursor: first.nextCursor! }), error => (error as { status: number }).status === 409);
});

test("commit details use the selected merge parent and root commits compare against an empty tree", async t => {
  const { cwd, git } = await repository(t);
  await writeFile(join(cwd, "file.txt"), "original\n"); await git("add", "."); await git("commit", "-m", "subject\n\nDetailed message <script>\nSecond paragraph");
  const root = await git("rev-parse", "HEAD");
  const detail = await workspaceGitCommit(cwd, root);
  assert.equal(detail.author, "History Test"); assert.match(detail.message, /Detailed message <script>/);
  assert.deepEqual(detail.parents, []); assert.equal(detail.files[0]?.status, "A"); assert.equal(detail.files[0]?.additions, 1);
  const added = await workspaceGitCommitDiff(cwd, root, "file.txt");
  assert.equal(added.kind, "text"); assert.equal(added.parentHash, null); if (added.kind === "text") assert.match(added.patch, /\+original/);
  await git("switch", "-c", "feature"); await writeFile(join(cwd, "feature.txt"), "feature\n"); await git("add", "."); await git("commit", "-m", "feature");
  await git("switch", "main"); await writeFile(join(cwd, "main.txt"), "main\n"); await git("add", "."); await git("commit", "-m", "main");
  await git("merge", "--no-ff", "feature", "-m", "merge"); const merge = await git("rev-parse", "HEAD");
  assert.deepEqual((await workspaceGitCommit(cwd, merge, 0)).files.map(file => file.path), ["feature.txt"]);
  assert.deepEqual((await workspaceGitCommit(cwd, merge, 1)).files.map(file => file.path), ["main.txt"]);
  await assert.rejects(workspaceGitCommit(cwd, merge, 2));
});

test("commit history supports SHA-256 repositories and disables worktree conversion helpers", async t => {
  const { cwd, git } = await repository(t);
  await rm(join(cwd, ".git"), { recursive: true }); await git("init", "--object-format=sha256", "-b", "main");
  await writeFile(join(cwd, "file.txt"), "first\n"); await writeFile(join(cwd, ".gitattributes"), "*.txt diff=custom\n");
  await git("add", "."); await git("commit", "-m", "base");
  await git("config", "diff.custom.command", "false"); await git("config", "diff.custom.textconv", "false");
  await writeFile(join(cwd, "file.txt"), "second\n"); await git("add", "."); await git("commit", "-m", "updated");
  const hash = await git("rev-parse", "HEAD"); assert.equal(hash.length, 64);
  assert.equal((await workspaceGitHistory(cwd)).commits[0]!.hash, hash);
  assert.equal((await workspaceGitCommit(cwd, hash)).files[0]?.additions, 1);
  const diff = await workspaceGitCommitDiff(cwd, hash, "file.txt");
  assert.equal(diff.kind, "text"); if (diff.kind === "text") assert.match(diff.patch, /-first\n\+second/);
});

test("history diffs stay scoped, handle literal and deleted paths, binary files, and reject unreachable revisions", async t => {
  const { cwd, git } = await repository(t); await mkdir(join(cwd, "app"));
  await writeFile(join(cwd, "private.txt"), "OUTSIDE\n"); await writeFile(join(cwd, "app", ":(glob)* 中文.txt"), "inside\n");
  await writeFile(join(cwd, "app/deleted.txt"), "deleted\n"); await git("add", "."); await git("commit", "-m", "initial");
  await rm(join(cwd, "app/deleted.txt")); await writeFile(join(cwd, "app/binary.bin"), Buffer.from([0, 255])); await git("add", "."); await git("commit", "-m", "second");
  const hash = await git("rev-parse", "HEAD"); const scope = join(cwd, "app");
  const detail = await workspaceGitCommit(scope, hash);
  assert.equal(detail.scope, "app/"); assert.deepEqual(detail.files.map(file => file.path), ["binary.bin", "deleted.txt"]);
  assert.equal((await workspaceGitCommitDiff(scope, hash, "binary.bin")).kind, "binary");
  const removed = await workspaceGitCommitDiff(scope, hash, "deleted.txt");
  assert.equal(removed.kind, "text"); if (removed.kind === "text") assert.match(removed.patch, /-deleted/);
  await assert.rejects(workspaceGitCommitDiff(scope, hash, "../private.txt"));
  await assert.rejects(workspaceGitCommitDiff(scope, hash, "private.txt"));
  const initial = (await workspaceGitHistory(scope)).commits.at(-1)!;
  const literal = await workspaceGitCommitDiff(scope, initial.hash, ":(glob)* 中文.txt"); assert.equal(literal.kind, "text");
  for (const invalid of ["HEAD", "--all", "main~1", "a".repeat(39), "0".repeat(40)]) await assert.rejects(workspaceGitCommit(cwd, invalid));
  const orphan = await git("commit-tree", `${hash}^{tree}`, "-m", "unreachable private message");
  await assert.rejects(workspaceGitCommit(cwd, orphan), error => (error as { status: number }).status === 404);
});

test("history supports detached linked worktrees and validates cursor and page bounds", async t => {
  const { cwd, git } = await repository(t);
  await writeFile(join(cwd, "file.txt"), "base\n"); await git("add", "."); await git("commit", "-m", "base");
  const hash = await git("rev-parse", "HEAD");
  const worktree = `${cwd}-linked`; t.after(() => rm(worktree, { recursive: true, force: true })); await git("worktree", "add", "--detach", worktree);
  assert.equal((await workspaceGitHistory(worktree)).head, hash);
  assert.equal((await workspaceGitCommit(worktree, hash)).hash, hash);
  for (const options of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { cursor: "invalid" }, { cursor: "x".repeat(1000) }]) await assert.rejects(workspaceGitHistory(cwd, options));
});

test("large historical patches are bounded and comparison reads preserve the current index and working files", async t => {
  const { cwd, git } = await repository(t);
  await writeFile(join(cwd, "large.txt"), "x".repeat(600 * 1024)); await git("add", "."); await git("commit", "-m", "large initial file");
  const hash = await git("rev-parse", "HEAD");
  assert.equal((await workspaceGitCommitDiff(cwd, hash, "large.txt")).kind, "too-large");
  await writeFile(join(cwd, "large.txt"), "local replacement\n"); await git("add", ".");
  await writeFile(join(cwd, "large.txt"), "uncommitted replacement\n");
  assert.equal((await workspaceGitCommitDiff(cwd, hash, "large.txt")).kind, "too-large");
  assert.equal(await git("show", ":large.txt"), "local replacement");
  assert.equal(await git("diff", "--numstat"), "1\t1\tlarge.txt");
});
