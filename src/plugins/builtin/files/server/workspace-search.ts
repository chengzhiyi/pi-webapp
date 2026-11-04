import type { Dir } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { git, gitRepository, WorkspaceGitError } from "../../git/server/public.ts";

type Repository = Awaited<ReturnType<typeof gitRepository>>;
import type { WorkspaceFileSearch, WorkspaceFileState, WorkspaceFileStatus } from "../contract/workspace-files.ts";
import { WorkspaceFileError } from "./workspace-files.ts";

const MAX_STATUS = 5000;
const MAX_CANDIDATES = 20000;
const MAX_NAME_RESULTS = 100;
const MAX_CONTENT_RESULTS = 200;
const MAX_CONTENT_FILES = 5000;
const MAX_CONTENT_BYTES = 512 * 1024;
const CONTENT_BUDGET_MS = 4000;
const MAX_LINE_TEXT = 240;
/** Outside Git there is no ignore file to consult; skip the directories that are never worth scanning. */
const WALK_SKIP = new Set([".git", "node_modules", ".hg", ".svn"]);

function scoped(scope: string, path: string): string | undefined {
  return path.startsWith(scope) ? path.slice(scope.length) || undefined : undefined;
}

function stateOf(x: string, y: string): WorkspaceFileState {
  if (x === "D" || y === "D") return x === "A" ? "added" : "deleted";
  if (x === "A" && (y === "." || y === "M")) return "added";
  return "modified";
}

/** Decorations for the tree: changed, untracked and ignored paths under the session workspace. */
export async function workspaceFileStatus(cwd: string): Promise<WorkspaceFileStatus> {
  let repository: Repository;
  try { repository = await gitRepository(cwd); }
  catch (error) { if (error instanceof WorkspaceGitError) return { kind: "unavailable", entries: [], truncated: false }; throw error; }
  if (repository.kind !== "repository") return { kind: repository.kind, entries: [], truncated: false };
  let output: string;
  try { output = await git(repository.cwd, ["status", "--porcelain=v2", "-z", "--untracked-files=normal", "--ignored=matching", "--", "."], 8 * 1024 * 1024); }
  catch (error) { if (error instanceof WorkspaceGitError) return { kind: "unavailable", entries: [], truncated: false }; throw error; }
  const status: WorkspaceFileStatus = { kind: "repository", entries: [], truncated: false };
  const records = output.split("\0");
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;
    const type = record[0];
    if (!["1", "2", "u", "?", "!"].includes(type ?? "")) continue;
    // Split only the fixed metadata fields: spaces in filenames are literal with -z.
    const fields = type === "?" || type === "!" ? 1 : type === "1" ? 8 : type === "2" ? 9 : 10;
    let start = 0;
    for (let part = 0; part < fields; part++) start = record.indexOf(" ", start) + 1;
    if (type === "2") index++;
    const path = scoped(repository.scope, record.slice(start));
    if (!path) continue;
    if (status.entries.length === MAX_STATUS) { status.truncated = true; break; }
    const xy = record.slice(2, 4);
    const state: WorkspaceFileState = type === "?" ? "untracked" : type === "!" ? "ignored" : type === "u" ? "conflict" : stateOf(xy[0]!, xy[1]!);
    status.entries.push({ path, state });
  }
  return status;
}

/** Candidate files: Git's tracked plus unignored untracked files, or a bounded walk outside a repository. */
async function candidates(cwd: string): Promise<{ root: string; paths: string[]; truncated: boolean }> {
  const root = await realpath(cwd);
  let repository: Repository | undefined;
  try { repository = await gitRepository(root); } catch { repository = undefined; }
  if (repository?.kind === "repository") {
    try {
      const output = await git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--deduplicate", "--", "."], 32 * 1024 * 1024);
      const paths = output.split("\0").filter(Boolean);
      return { root, paths: paths.slice(0, MAX_CANDIDATES), truncated: paths.length > MAX_CANDIDATES };
    } catch (error) { if (!(error instanceof WorkspaceGitError)) throw error; }
  }
  const paths: string[] = [];
  const queue = [""];
  while (queue.length) {
    const directory = queue.shift()!;
    let entries: Dir;
    try { entries = await opendir(join(root, directory)); } catch { continue; }
    for await (const entry of entries) {
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      // Symbolic links are never followed, so the walk cannot leave the workspace.
      if (entry.isDirectory()) { if (!WALK_SKIP.has(entry.name)) queue.push(path); }
      else if (entry.isFile()) {
        if (paths.length === MAX_CANDIDATES) return { root, paths, truncated: true };
        paths.push(path);
      }
    }
  }
  return { root, paths, truncated: false };
}

/** Lower is better; undefined when the query letters do not appear in order. */
function nameScore(path: string, query: string): number | undefined {
  const lower = path.toLowerCase();
  const name = lower.slice(lower.lastIndexOf("/") + 1);
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  if (lower.includes(query)) return 3;
  let at = 0;
  for (const char of query) { at = lower.indexOf(char, at) + 1; if (!at) return undefined; }
  return 4;
}

/** `name` ranks matching paths; `content` finds case-insensitive literal text in text files. */
export async function searchWorkspaceFiles(cwd: string, query: unknown, mode: unknown): Promise<WorkspaceFileSearch> {
  if (typeof query !== "string" || !query.trim() || query.length > 200 || query.includes("\0")) throw new WorkspaceFileError("搜索内容无效");
  if (mode !== "name" && mode !== "content") throw new WorkspaceFileError("搜索方式无效");
  const needle = query.trim().toLowerCase();
  const { root, paths, truncated } = await candidates(cwd);
  if (mode === "name") {
    const ranked = paths.flatMap(path => { const score = nameScore(path, needle); return score === undefined ? [] : [{ path, score }]; })
      .sort((a, b) => a.score - b.score || a.path.length - b.path.length || a.path.localeCompare(b.path));
    return { kind: "name", results: ranked.slice(0, MAX_NAME_RESULTS).map(({ path }) => ({ path })), truncated: truncated || ranked.length > MAX_NAME_RESULTS };
  }
  const results: { path: string; line: number; text: string }[] = [];
  const deadline = Date.now() + CONTENT_BUDGET_MS;
  let scanned = 0;
  let stopped = truncated;
  for (const path of paths) {
    if (results.length >= MAX_CONTENT_RESULTS || scanned >= MAX_CONTENT_FILES || Date.now() > deadline) { stopped = true; break; }
    const target = join(root, path);
    try {
      const info = await lstat(target);
      if (!info.isFile() || info.size === 0 || info.size > MAX_CONTENT_BYTES) continue;
      scanned++;
      const file = await open(target, "r");
      let bytes: Buffer;
      try { bytes = await file.readFile(); } finally { await file.close(); }
      if (bytes.includes(0)) continue;
      const lines = bytes.toString("utf8").split("\n");
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index]!;
        const at = line.toLowerCase().indexOf(needle);
        if (at < 0) continue;
        // Keep the match visible in long lines.
        const from = Math.max(0, at - 60);
        results.push({ path, line: index + 1, text: (from ? "…" : "") + line.slice(from, from + MAX_LINE_TEXT).replace(/\r$/u, "") });
        if (results.length >= MAX_CONTENT_RESULTS) break;
      }
    } catch { /* Files that vanish or cannot be read are skipped. */ }
  }
  return { kind: "content", results, truncated: stopped };
}
