import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
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
/** All activation and write commits share this lock, including independent bridge processes.
 * Never reclaim by PID or delete a lock that another writer may have acquired.
 */
export async function withStorageLock<T>(root: string, operation: () => Promise<T>, timeoutMs = 2000): Promise<T> {
  await privateDirectory(root);
  const path = join(root, "transaction.lock");
  const deadline = Date.now() + timeoutMs;
  let lock;
  for (;;) {
    try { lock = await open(path, "wx", 0o600); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new HostedPluginError("storage_busy", "Plugin storage is locked; stop all writers before recovering an abandoned lock");
      await delay(10);
    }
  }
  try { await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })); return await operation(); }
  finally { await lock.close(); await unlink(path); }
}
