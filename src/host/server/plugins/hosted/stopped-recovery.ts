import { lstat, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { sha256 } from "./resources.ts";
import { atomicJson, boundedRead, readJournal } from "./storage.ts";
import { HostedStateBroker, type ActiveHostedPlugin } from "./state-broker.ts";
import { HostedPluginError } from "./errors.ts";

export const STOPPED_CONFIRMATION = "ALL_HOSTS_AND_PLUGIN_WORKERS_STOPPED_AND_BACKUP_VERIFIED";
/** Offline operator utility, NEVER an HTTP handler. PID liveness is not ownership proof.
 * The operator must externally fence every host/worker before inspection and keep them stopped.
 * Fingerprint binds confirmation to all inspected bytes, not merely the stale lock's PID.
 */
export async function inspectStoppedStorage(root: string) {
  const files: Array<{ path: string; bytes: number; sha256: string }> = [];
  async function walk(directory: string, prefix = ""): Promise<void> {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new HostedPluginError("invalid_storage", "Recovery refuses linked/non-directory storage");
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name), relative = prefix + name, info = await lstat(path);
      if (info.isSymbolicLink()) throw new HostedPluginError("invalid_storage", "Recovery refuses links");
      if (info.isDirectory()) await walk(path, relative + "/");
      else {
        if (files.length >= 10000) throw new HostedPluginError("invalid_storage", "Recovery inspection budget exceeded");
        const bytes = await boundedRead(path, 192 * 1024 * 1024);
        if (!bytes) throw new HostedPluginError("invalid_storage", "Recovery input disappeared");
        files.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes) });
      }
    }
  }
  await walk(root);
  return { fingerprint: sha256(JSON.stringify(files)), files,
    warning: "Offline only: externally stop/fence ALL hosts and plugin workers, back up storage and workspace files. Never infer stopped ownership from PID alone." };
}
/** Renames only known ownership locks, preserving their bytes for audit. No state/journal repair,
 * no active-pointer rollback, no workspace access. Requires exclusive offline operator custody.
 * This is NOT a safe online CAS/lock-steal primitive: filesystem rename has no compare-and-swap.
 */
export async function reconcileStoppedTransition(storageRoot: string, pluginId: string, expectedFingerprint: string, confirmation: string) {
  const broker = new HostedStateBroker(storageRoot, pluginId);
  const report = await inspectStoppedStorage(broker.root);
  if (confirmation !== STOPPED_CONFIRMATION) throw new HostedPluginError("confirmation_required", "Explicit stopped-owner and verified-backup confirmation required");
  if (report.fingerprint !== expectedFingerprint) throw new HostedPluginError("recovery_changed", "Storage changed since inspection");
  return broker.recover(); // Active pointer remains the sole source of truth; never rolls back state.
}

export async function recoverStoppedFork(storageRoot: string, pluginId: string, expectedFingerprint: string, confirmation: string) {
  const broker = new HostedStateBroker(storageRoot, pluginId), root = broker.root;
  if (confirmation !== STOPPED_CONFIRMATION) throw new HostedPluginError("confirmation_required", "Explicit stopped-owner and verified-backup confirmation required");
  const report = await inspectStoppedStorage(root);
  if (report.fingerprint !== expectedFingerprint) throw new HostedPluginError("recovery_changed", "Storage changed since inspection");
  if (await boundedRead(join(root, "transition.json"), 2 * 1024 * 1024)) throw new HostedPluginError("gc_recovery_required", "Reconcile transition.json using broker.recover before resolving a fork");
  const fork = await readJournal<{ version: number; stateRef: string }>(join(root, "fork.json"));
  const active = await broker.active(), previous = await readJournal<ActiveHostedPlugin>(join(root, "previous.json"));
  if (!fork || fork.version !== 1 || !/^[a-f0-9-]{36}$/.test(fork.stateRef) || Object.keys(fork).some(k => !["version", "stateRef"].includes(k)) || !active || previous && typeof previous.stateRef !== "string" || [active?.stateRef, previous?.stateRef].includes(fork.stateRef)) throw new HostedPluginError("gc_recovery_required", "Fork is unknown or referenced by active/previous; original bytes preserved");
  const target = `recovered-${expectedFingerprint}-fork.json`;
  if (report.files.some(f => f.path === target)) throw new HostedPluginError("recovery_changed", "Recovery evidence already exists");
  await rename(join(root, "fork.json"), join(root, target));
  // Snapshot bytes are retained. Normal reference-aware GC validates them before any deletion.
  return { recovered: "fork.json", stateRef: fork.stateRef, fingerprint: expectedFingerprint };
}

export async function recoverStoppedLocks(root: string, expectedFingerprint: string, confirmation: string) {
  if (confirmation !== STOPPED_CONFIRMATION || !/^[a-f0-9]{64}$/.test(expectedFingerprint)) throw new HostedPluginError("confirmation_required", "Explicit stopped-owner and verified-backup confirmation required");
  const report = await inspectStoppedStorage(root);
  if (report.fingerprint !== expectedFingerprint) throw new HostedPluginError("recovery_changed", "Storage changed since inspection; nothing recovered, inspect again");
  const locks = report.files.filter(f => ["runtime.lock", "transaction.lock"].includes(f.path));
  // Refuse overwriting prior evidence. A repeated application needs a fresh inspection.
  for (const lock of locks) {
    const target = `recovered-${expectedFingerprint}-${lock.path}.json`;
    if (report.files.some(f => f.path === target)) throw new HostedPluginError("recovery_changed", "Recovery evidence already exists");
  }
  for (const lock of locks) await rename(join(root, lock.path), join(root, `recovered-${expectedFingerprint}-${lock.path}.json`));
  await atomicJson(join(root, `recovery-${expectedFingerprint}.json`), { version: 1, fingerprint: expectedFingerprint, locks, confirmation, recoveredAt: new Date().toISOString() });
  return { recovered: locks.map(f => f.path), fingerprint: expectedFingerprint };
}
