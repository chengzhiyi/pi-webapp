import { createHash } from "node:crypto";
import type { GitCommitDetail, GitCommitDiff, GitCommitFile, GitCommitSummary, GitHistory, GitRef } from "../contract/workspace-git.ts";
import { git, gitRepository, validateGitPath, WorkspaceGitError, type GitRepository } from "./git-command.ts";

const HASH = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const FORMAT = "%H%x00%P%x00%an%x00%aI%x00%s";
const DIFF_OPTIONS = ["--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", "--relative"];

async function references(cwd: string) {
  const [output, head, symbolic] = await Promise.all([
    git(cwd, ["for-each-ref", "--format=%(refname)%00%(objecttype)%00%(objectname)%00%(*objecttype)%00%(*objectname)", "refs/heads", "refs/remotes", "refs/tags"]),
    git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]).then(value => value.trim(), () => null),
    git(cwd, ["symbolic-ref", "-q", "HEAD"]).then(value => value.trim(), () => null),
  ]);
  const refs: GitRef[] = [];
  for (const line of output.split("\n").filter(Boolean)) {
    const [full, type, object, peeledType, peeled] = line.split("\0");
    const hash = type === "commit" ? object : peeledType === "commit" ? peeled : undefined;
    if (!hash || !HASH.test(hash)) continue;
    const kind = full!.startsWith("refs/heads/") ? "branch" : full!.startsWith("refs/remotes/") ? "remote" : "tag";
    refs.push({ name: full!.replace(/^refs\/(?:heads|remotes|tags)\//, ""), hash, kind });
  }
  if (refs.length > 512) throw new WorkspaceGitError("仓库引用过多，暂不支持读取历史", 413);
  const tips = [...new Set([...refs.map(ref => ref.hash), ...(head && HASH.test(head) ? [head] : [])])].sort();
  const snapshot = createHash("sha256").update(JSON.stringify({ refs, head, symbolic })).digest("hex");
  return { refs, tips, head, snapshot };
}

function summary(fields: string[]): GitCommitSummary {
  const [hash, parents, author, authoredAt, subject] = fields;
  if (!hash || !HASH.test(hash) || !parents?.split(" ").filter(Boolean).every(parent => HASH.test(parent))) throw new WorkspaceGitError("提交格式无效", 422);
  return { hash, parents: parents.split(" ").filter(Boolean), author: author!, authoredAt: authoredAt!, subject: subject! };
}

export async function workspaceGitHistory(cwd: string, options: { limit?: number; cursor?: string } = {}): Promise<GitHistory> {
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (options.cursor !== undefined && (typeof options.cursor !== "string" || options.cursor.length > 256))) throw new WorkspaceGitError("历史分页参数无效");
  const repository = await gitRepository(cwd);
  const empty: GitHistory = { kind: repository.kind, root: null, scope: "", head: null, snapshot: "", refs: [], commits: [], nextCursor: null };
  if (repository.kind !== "repository") return empty;
  const refs = await references(repository.cwd);
  let offset = 0;
  if (options.cursor !== undefined) {
    let cursor: { snapshot?: unknown; offset?: unknown };
    try { cursor = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8")); }
    catch { throw new WorkspaceGitError("历史分页参数无效"); }
    if (!cursor || typeof cursor.snapshot !== "string" || !/^[a-f0-9]{64}$/.test(cursor.snapshot) || !Number.isInteger(cursor.offset) || (cursor.offset as number) < 1 || (cursor.offset as number) > 10000) throw new WorkspaceGitError("历史分页参数无效");
    if (cursor.snapshot !== refs.snapshot) throw new WorkspaceGitError("仓库引用已变化，请刷新历史", 409);
    offset = cursor.offset as number;
  }
  const result: GitHistory = { ...empty, root: repository.root, scope: repository.scope, head: refs.head, snapshot: refs.snapshot, refs: refs.refs };
  if (!refs.tips.length) return result;
  const output = await git(repository.cwd, ["log", "--no-notes", "--no-show-signature", "--encoding=UTF-8", "--topo-order", "-z", `--format=${FORMAT}`, `--max-count=${limit + 1}`, `--skip=${offset}`, ...refs.tips, "--"]);
  const fields = output.split("\0"); if (fields.at(-1) === "") fields.pop();
  if (fields.length % 5) throw new WorkspaceGitError("提交格式无效", 422);
  const commits: GitCommitSummary[] = [];
  for (let index = 0; index < fields.length; index += 5) commits.push(summary(fields.slice(index, index + 5)));
  result.commits = commits.slice(0, limit);
  if (commits.length > limit && offset + limit <= 10000) result.nextCursor = Buffer.from(JSON.stringify({ snapshot: refs.snapshot, offset: offset + limit })).toString("base64url");
  return result;
}

async function selectedCommit(cwd: string, hash: string) {
  if (typeof hash !== "string" || !HASH.test(hash)) throw new WorkspaceGitError("提交标识无效");
  const repository = await gitRepository(cwd);
  if (repository.kind !== "repository") throw new WorkspaceGitError("当前工作区没有可读取的 Git 仓库", 404);
  const refs = await references(repository.cwd);
  if (!refs.tips.length) throw new WorkspaceGitError("提交不存在或已不可达", 404);
  const type = await git(repository.cwd, ["cat-file", "-t", hash]).catch(() => "");
  if (type.trim() !== "commit" || (await git(repository.cwd, ["rev-list", "--max-count=1", hash, "--not", ...refs.tips, "--"])).trim()) throw new WorkspaceGitError("提交不存在或已不可达", 404);
  return repository;
}

function comparison(hash: string, parents: string[], parentIndex: number): string[] {
  if (!Number.isInteger(parentIndex) || parentIndex < 0 || parentIndex >= Math.max(1, parents.length)) throw new WorkspaceGitError("父提交选择无效");
  return parents.length ? [parents[parentIndex]!, hash] : [hash];
}

async function commitData(repository: GitRepository, hash: string, parentIndex: number): Promise<GitCommitDetail> {
  const output = await git(repository.cwd, ["show", "-s", "--no-notes", "--no-show-signature", "--encoding=UTF-8", "-z", `--format=${FORMAT}%x00%ae%x00%cn%x00%ce%x00%cI%x00%B`, hash, "--"], 256 * 1024);
  const fields = output.split("\0"); if (fields.at(-1) === "") fields.pop();
  if (fields.length !== 10) throw new WorkspaceGitError("提交格式无效", 422);
  const commit = summary(fields.slice(0, 5));
  const revision = comparison(hash, commit.parents, parentIndex);
  const base = ["diff-tree", "--root", "-r", "--no-commit-id", ...DIFF_OPTIONS];
  const [names, stats] = await Promise.all([
    git(repository.cwd, [...base, "--name-status", "-z", ...revision, "--", "."]),
    git(repository.cwd, [...base, "--numstat", "-z", ...revision, "--", "."]),
  ]);
  const counts = new Map<string, [number | null, number | null]>();
  for (const record of stats.split("\0").filter(Boolean)) {
    const match = record.match(/^(\d+|-)\t(\d+|-)\t([\s\S]+)$/);
    if (match) counts.set(match[3]!, [match[1] === "-" ? null : Number(match[1]), match[2] === "-" ? null : Number(match[2])]);
  }
  const records = names.split("\0"); if (records.at(-1) === "") records.pop();
  if (records.length % 2) throw new WorkspaceGitError("提交文件格式无效", 422);
  const files: GitCommitFile[] = [];
  for (let index = 0; index < records.length && files.length < 1000; index += 2) {
    const path = records[index + 1]!;
    const [additions, deletions] = counts.get(path) ?? [null, null];
    files.push({ path, status: records[index]!, additions, deletions });
  }
  return { ...commit, email: fields[5]!, committer: fields[6]!, committerEmail: fields[7]!, committedAt: fields[8]!, message: fields[9]!,
    root: repository.root, scope: repository.scope, parentIndex, files, truncated: records.length > 2000 };
}

export async function workspaceGitCommit(cwd: string, hash: string, parentIndex = 0): Promise<GitCommitDetail> {
  return commitData(await selectedCommit(cwd, hash), hash, parentIndex);
}

export async function workspaceGitCommitDiff(cwd: string, hash: string, path: string, parentIndex = 0): Promise<GitCommitDiff> {
  validateGitPath(path);
  const repository = await selectedCommit(cwd, hash);
  const commit = await commitData(repository, hash, parentIndex);
  const file = commit.files.find(file => file.path === path);
  if (!file) throw new WorkspaceGitError("文件不在当前目录的提交改动中", 404);
  const meta = { hash, path, parentIndex, parentHash: commit.parents[parentIndex] ?? null };
  if (file.additions === null) return { ...meta, kind: "binary" };
  try {
    const patch = await git(repository.cwd, ["diff-tree", "--root", "-r", "--no-commit-id", ...DIFF_OPTIONS, "--src-prefix=a/", "--dst-prefix=b/", "-p", ...comparison(hash, commit.parents, parentIndex), "--", path], 512 * 1024);
    if (patch.split("\n").length > 10000) return { ...meta, kind: "too-large" };
    return patch ? { ...meta, kind: "text", patch } : { ...meta, kind: "empty" };
  } catch (error) {
    if (error instanceof WorkspaceGitError && error.status === 413) return { ...meta, kind: "too-large" };
    throw error;
  }
}
