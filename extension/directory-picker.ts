import { mkdir, opendir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, posix, resolve, win32 } from "node:path";

export interface DirectoryEntry { name: string; path: string; hidden: boolean }
export interface DirectoryListing {
  path: string;
  home: string;
  crumbs: DirectoryEntry[];
  entries: DirectoryEntry[];
  truncated: boolean;
}

function fullyQualified(path: string): boolean {
  return process.platform === "win32"
    ? win32.isAbsolute(path) && /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/]+)/.test(path)
    : posix.isAbsolute(path);
}

interface Candidate { name: string; isDirectory: boolean; isSymbolicLink: boolean }

/** Keep the name-sorted head of a large directory. */
function boundedInsert(window: Candidate[], candidate: Candidate, keep: number): boolean {
  if (window.length === keep && candidate.name.localeCompare(window[window.length - 1]!.name) >= 0) return true;
  let low = 0;
  let high = window.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (candidate.name.localeCompare(window[middle]!.name) < 0) high = middle;
    else low = middle + 1;
  }
  window.splice(low, 0, candidate);
  if (window.length <= keep) return false;
  window.pop();
  return true;
}

export async function listDirectory(path?: string): Promise<DirectoryListing> {
  if (path !== undefined && !fullyQualified(path)) throw new Error("目录路径必须是绝对路径");
  const home = homedir();
  const target = resolve(path ?? home);
  const crumbs: DirectoryEntry[] = [];
  for (let current = target;; current = dirname(current)) {
    const parent = dirname(current);
    crumbs.unshift({ name: parent === current ? current : basename(current), path: current, hidden: false });
    if (parent === current) break;
  }
  const candidates: Candidate[] = [];
  let truncated = false;
  const level = await opendir(target);
  for await (const entry of level) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (boundedInsert(candidates, { name: entry.name, isDirectory: entry.isDirectory(), isSymbolicLink: entry.isSymbolicLink() }, 1001)) truncated = true;
  }
  const entries: DirectoryEntry[] = [];
  for (const entry of candidates) {
    const child = join(target, entry.name);
    if (!entry.isDirectory && entry.isSymbolicLink) {
      try { if (!(await stat(child)).isDirectory()) continue; }
      catch { continue; }
    }
    if (entries.length === 1000) { truncated = true; break; }
    entries.push({ name: entry.name, path: child, hidden: entry.name.startsWith(".") });
  }
  return { path: target, home, crumbs, entries, truncated };
}

export async function createDirectory(path: string, name: string): Promise<string> {
  if (!fullyQualified(path)) throw new Error("父目录路径必须是绝对路径");
  if (!name.trim() || name === "." || name === ".." || /[/\\]/.test(name)) throw new Error("文件夹名称无效");
  const target = join(resolve(path), name);
  await mkdir(target);
  return target;
}
