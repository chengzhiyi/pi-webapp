import { constants } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { HostedPluginError, isMissing } from "./errors.ts";

export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new HostedPluginError("invalid_storage", "Plugin storage must be a real directory");
}
export async function boundedRead(path: string, maxBytes: number): Promise<Buffer | null> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0)); }
  catch (error) { if (isMissing(error)) return null; throw error; }
  try {
    const info = await file.stat();
    // atomicJson may replace the pathname after open but before fstat. The pinned
    // descriptor then has nlink=0 and still contains the complete old snapshot,
    // exactly as a replacement just after fstat would. Multiple live hard links
    // remain forbidden; never reopen the pathname or mix bytes from two versions.
    if (!info.isFile() || info.nlink > 1 || info.size > maxBytes) throw new HostedPluginError("invalid_storage", "Invalid storage record size or type");
    const bytes = Buffer.alloc(Math.min(info.size + 1, maxBytes + 1)); let length = 0;
    while (length < bytes.length) { const read = await file.read(bytes, length, bytes.length - length, length); if (!read.bytesRead) break; length += read.bytesRead; }
    if (length > maxBytes || length !== info.size) throw new HostedPluginError("invalid_storage", "Storage record changed during read");
    return bytes.subarray(0, length);
  } finally { await file.close(); }
}
export async function readJson<T>(path: string, maxBytes = 2 * 1024 * 1024): Promise<T | null> {
  const bytes = await boundedRead(path, maxBytes);
  if (!bytes) return null;
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as T; }
  catch { throw new HostedPluginError("invalid_storage", "Invalid JSON storage record; original bytes preserved"); }
}
/** Journals must be objects: JSON null/false is corruption, never absence or recovery consent. */
export async function readJournal<T>(path: string): Promise<T | null> {
  const bytes = await boundedRead(path, 2 * 1024 * 1024);
  if (bytes === null) return null;
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new HostedPluginError("gc_recovery_required", `Invalid journal ${path}; stop all owners and inspect original bytes`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HostedPluginError("gc_recovery_required", `Invalid journal ${path}; original bytes preserved`);
  return value as T;
}
export async function atomicJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  const file = await open(temp, "wx", 0o600);
  try {
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
    await rename(temp, path);
    // Sync directory metadata on platforms supporting directory fsync.
    let directory;
    try { directory = await open(dirname(path), "r"); await directory.sync(); }
    catch (error) { if (!["EINVAL", "EPERM", "EACCES", "EISDIR", "ENOTSUP", "EBADF"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
    finally { await directory?.close(); }
  } finally { await unlink(temp).catch(() => {}); }
}
/** Compatibility fence: old O_EXCL hosts must fail closed while custody is held.
 * The marker is NOT proof of live ownership. Only its owner removes it on normal
 * release. A crashed v2 marker is reusable under kernel custody, never stolen.
 */
export const OWNERSHIP_MARKER = '{"version":2,"mechanism":"sqlite-exclusive"}';
export const isOwnershipMarker = (bytes: Buffer) => bytes.toString("utf8") === OWNERSHIP_MARKER;

// Avoid hammering synchronous SQLite lock attempts against our own event loop.
// On Windows even busy_timeout=0 can involve native lock retry sleeps. This is
// only a contention optimization: every grant still requires kernel custody,
// and aliases/independent processes remain protected by SQLite, not this set.
const localCustody = new Set<string>();

/** Kernel-managed custody on a LOCAL filesystem. SQLite BEGIN EXCLUSIVE is an OS
 * byte-range lock, not a PID/TTL lease. Closing/crashing releases it; no abandoned
 * pathname is deleted, renamed or replaced. The database stores no application data.
 * Legacy/unknown markers still require externally fenced, backed-up recovery.
 */
export async function acquireStorageOwnership(root: string, name: "runtime" | "transaction", timeoutMs = 0): Promise<() => Promise<void>> {
  await privateDirectory(root);
  const marker = join(root, `${name}.lock`), path = join(root, `${name}.ownership.sqlite`);
  const code = name === "runtime" ? "runtime_owned" : "storage_busy";
  const legacyError = () => new HostedPluginError(code, "Another host owns this plugin storage or a legacy ownership lock remains; stop all owners and verify a backup before offline recovery");
  // Secure initial creation. Do not replace an existing inode: its kernel lock
  // may be held by another connection/process. Refuse links and special files.
  let seed;
  try { seed = await open(path, "wx", 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  finally { await seed?.close(); }
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1024 * 1024) throw new HostedPluginError("invalid_storage", "Ownership database must be a small, single-link regular file");
  const db = new DatabaseSync(path, { allowExtension: false });
  const key = resolve(path), deadline = Date.now() + timeoutMs;
  let acquired = false;
  try {
    // busy_timeout remains zero: waiting must yield to the owner's JS event loop.
    for (;;) {
      if (!localCustody.has(key)) {
        try {
          db.exec("BEGIN EXCLUSIVE");
          localCustody.add(key); acquired = true; break;
        } catch (error) {
          if ((error as { errcode?: number }).errcode !== 5) throw error;
        }
      }
      if (Date.now() >= deadline) throw new HostedPluginError(code, "Another host owns this plugin storage; wait for it to stop before retrying");
      await delay(10);
    }
    let current = await boundedRead(marker, 4096);
    if (current === null) {
      let file;
      try {
        file = await open(marker, "wx", 0o600);
        await file.writeFile(OWNERSHIP_MARKER); await file.sync();
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      finally { await file?.close(); }
      current = await boundedRead(marker, 4096);
    }
    // A legacy host can win O_EXCL before the first marker is installed. Never
    // overwrite its record, even though it does not participate in SQLite locks.
    if (current === null || !isOwnershipMarker(current)) throw legacyError();
  } catch (error) {
    db.close();
    if (acquired) localCustody.delete(key);
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    const bytes = await boundedRead(marker, 4096);
    if (bytes === null || !isOwnershipMarker(bytes)) throw new HostedPluginError("invalid_storage", "Ownership fence changed while held; preserve custody and inspect storage");
    // Application writes/drain have finished. Remove ONLY our fence while still
    // holding the kernel lock. Legacy hosts may then win the next O_EXCL race;
    // a new host must acquire both kernel custody and the compatible marker.
    await unlink(marker);
    db.close(); localCustody.delete(key); released = true;
  };
}

/** All activation/write commits share kernel custody, including independent bridges.
 * Journals still decide crash reconciliation; acquiring a mutex never clears them.
 */
export async function withStorageLock<T>(root: string, operation: () => Promise<T>, timeoutMs = 2000): Promise<T> {
  const release = await acquireStorageOwnership(root, "transaction", timeoutMs);
  try { return await operation(); } finally { await release(); }
}
