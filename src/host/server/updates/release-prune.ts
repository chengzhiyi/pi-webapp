import { lstat, readdir, readFile, realpath, rm } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/** A release this young may be another process's download or a just-prepared candidate. */
export const releaseGraceMs = 24 * 60 * 60_000;
const maxStateBytes = 1024 * 1024;
const maxDepth = 4;

/** History folders are logs, never pointers: what they mention is not in use. */
const skipped = (name: string) => name === "releases" || name === "history" || name.endsWith("-history");

/** Collects every release folder name a live state file under pi-web points into. */
async function referencedReleases(stateRoot: string, spellings: string[]): Promise<Set<string>> {
  const referenced = new Set<string>();
  const prefixes = [...new Set(spellings.flatMap(path => [path + sep, path + "/"]))];
  const visit = (value: unknown) => {
    if (typeof value === "string") {
      for (const prefix of prefixes) {
        const index = value.indexOf(prefix);
        if (index >= 0) referenced.add(value.slice(index + prefix.length).split(/[\\/]/)[0]);
      }
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  const walk = async (directory: string, depth: number): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { if (depth < maxDepth && !skipped(entry.name)) await walk(path, depth + 1); continue; }
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        if ((await lstat(path)).size > maxStateBytes) continue;
        visit(JSON.parse(await readFile(path, "utf8")));
      } catch { /* Unreadable or mid-write: anything it names stays protected by the grace period. */ }
    }
  };
  await walk(stateRoot, 0);
  return referenced;
}

/**
 * Deletes downloaded releases nothing can start any more. Kept: the running package, every release a
 * live pointer (update/desktop-update/candidate/transaction/host-pair intent…) names, and anything
 * touched within the grace period. Best effort: a release that cannot be removed is left for next time.
 */
export async function pruneReleases(options: { agentDir: string; packageRoot: string; now?: number; graceMs?: number }): Promise<string[]> {
  const stateRoot = join(options.agentDir, "pi-web");
  let releases: string;
  try { releases = await realpath(join(stateRoot, "releases")); } catch { return []; }
  const now = options.now ?? Date.now(), graceMs = options.graceMs ?? releaseGraceMs;
  // Pointers may use the configured or the resolved (symlink-free) spelling of the folder.
  const keep = await referencedReleases(stateRoot, [join(stateRoot, "releases"), releases]);
  try {
    const running = relative(releases, await realpath(options.packageRoot));
    if (running && !running.startsWith("..")) keep.add(running.split(sep)[0]);
  } catch { /* Running package is gone or outside releases. */ }

  const removed: string[] = [];
  for (const entry of await readdir(releases, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || keep.has(entry.name)) continue;
    const path = join(releases, entry.name);
    try {
      if (now - (await lstat(path)).mtimeMs < graceMs) continue;
      await rm(path, { recursive: true, force: true });
      removed.push(entry.name);
    } catch { /* Left for the next run. */ }
  }
  return removed;
}
