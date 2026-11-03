// Launcher-owned host upgrade transaction.
//
// Layering: desktop shell -> launcher -> host -> plugins. The host (business package) only
// downloads, validates and writes a candidate. The launcher, a more stable layer, selects the
// pointer, admits the new host by health (the new launcher reports ready) and rolls back. Plugins
// take no part. Every record here carries a schema version and fails open: unreadable, unknown or
// expired state is moved aside (never deleted) and treated as absent.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { desktopProtocolVersion, desktopUpdatePath, readDesktopRelease, validateDesktopRelease, writeDesktopRelease } from "../desktop/managed-release.mjs";
import { parseVersion } from "../desktop/release-version.mjs";

export const upgradeSchema = 1;
/** A candidate nobody restarted into within a day is stale: download it again. */
export const candidateTtlMs = 24 * 60 * 60_000;
export const upgradeRoot = agentDir => join(agentDir, "pi-web", "upgrade");
export const candidatePath = agentDir => join(upgradeRoot(agentDir), "candidate.json");
export const upgradeTransactionPath = agentDir => join(upgradeRoot(agentDir), "transaction.json");
const historyRoot = agentDir => join(upgradeRoot(agentDir), "history");
const uuid = /^[a-f0-9-]{36}$/i;

async function atomicBytes(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, value, { mode: 0o600 }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
const atomicJson = (path, value) => atomicBytes(path, JSON.stringify(value));
/** Bytes are kept for diagnosis; a bad record never becomes a permanent fence. */
async function quarantine(path, reason) {
  await rename(path, `${path}.${reason}-${Date.now()}`).catch(error => { if (error?.code !== "ENOENT") throw error; });
}
async function readRecord(path, valid, expired = () => false) {
  let value;
  try { value = JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    await quarantine(path, "invalid"); return null;
  }
  if (!valid(value)) { await quarantine(path, "invalid"); return null; }
  if (expired(value)) { await quarantine(path, "expired"); return null; }
  return value;
}

export function validCandidate(value) {
  if (!value || typeof value !== "object" || value.schema !== upgradeSchema || !uuid.test(value.id ?? "")) return false;
  try { parseVersion(value.version); } catch { return false; }
  return typeof value.launcher === "string" && isAbsolute(value.launcher) && typeof value.packageRoot === "string" && isAbsolute(value.packageRoot)
    && ["stable", "alpha"].includes(value.channel) && typeof value.downgrade === "boolean" && !Number.isNaN(Date.parse(value.createdAt ?? ""));
}
export async function readCandidate(agentDir, now = Date.now()) {
  return readRecord(candidatePath(agentDir), validCandidate, value => now - Date.parse(value.createdAt) > candidateTtlMs);
}
/** Host side: the only upgrade write the business package makes. No lock, no pointer. */
export async function writeCandidate(agentDir, candidate) {
  const value = { schema: upgradeSchema, createdAt: new Date().toISOString(), ...candidate };
  if (!validCandidate(value)) throw new Error("Invalid upgrade candidate");
  await mkdir(upgradeRoot(agentDir), { recursive: true, mode: 0o700 });
  await atomicJson(candidatePath(agentDir), value);
  return value;
}
/** Moves the candidate aside into history (kept, never deleted) once it is consumed or cancelled. */
export async function retireCandidate(agentDir, id, outcome) {
  const current = await readCandidate(agentDir);
  if (!current || id && current.id !== id) return;
  await mkdir(historyRoot(agentDir), { recursive: true, mode: 0o700 });
  await rename(candidatePath(agentDir), join(historyRoot(agentDir), `${current.id}-candidate-${outcome}.json`)).catch(error => { if (error?.code !== "ENOENT") throw error; });
}

const phases = ["selected", "committed", "rolled-back"];
export function validUpgradeTransaction(value) {
  return !!value && typeof value === "object" && value.schema === upgradeSchema && uuid.test(value.id ?? "") && phases.includes(value.phase)
    && typeof value.version === "string" && typeof value.from === "string" && !Number.isNaN(Date.parse(value.updatedAt ?? ""));
}
export async function readUpgradeTransaction(agentDir) {
  return readRecord(upgradeTransactionPath(agentDir), validUpgradeTransaction);
}
export async function recordUpgradeTransaction(agentDir, transaction) {
  const value = { schema: upgradeSchema, ...transaction, updatedAt: new Date().toISOString() };
  if (!validUpgradeTransaction(value)) throw new Error("Invalid upgrade transaction");
  await mkdir(historyRoot(agentDir), { recursive: true, mode: 0o700 });
  await atomicJson(upgradeTransactionPath(agentDir), value);
  if (value.phase !== "selected") await atomicJson(join(historyRoot(agentDir), `${value.id}-${value.phase}.json`), value);
  return value;
}

async function bytes(path) {
  try { return await readFile(path); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}
/** Writes the pointer for a candidate with the running release as its rollback entry, and returns
 * the exact bytes before and after so rollback can compare-and-swap. */
export async function selectCandidate({ agentDir, desktop, currentVersion, candidate }) {
  const path = desktop ? desktopUpdatePath(agentDir) : join(agentDir, "pi-web", "update.json");
  const before = await bytes(path);
  if (desktop) {
    const selected = await validateDesktopRelease(agentDir, { version: candidate.version, launcher: candidate.launcher, desktopProtocolVersion });
    const saved = await readDesktopRelease(agentDir, currentVersion);
    const previous = saved?.version === currentVersion ? saved : null;
    const fallbackVersion = process.env.PI_WEBAPP_DESKTOP_VERSION ?? saved?.fallbackVersion ?? currentVersion;
    await writeDesktopRelease(agentDir, { ...selected, ...((candidate.downgrade || saved?.fallbackVersion) ? { fallbackVersion } : {}), ...(previous ? { previous } : {}) });
  } else {
    let saved;
    try { saved = JSON.parse(before?.toString("utf8") ?? "null"); } catch { saved = null; }
    const previous = saved?.version === currentVersion ? { ...saved } : undefined;
    // Keep only one rollback entry, never a recursively growing chain.
    if (previous) delete previous.previous;
    await mkdir(join(agentDir, "pi-web"), { recursive: true });
    await atomicJson(path, { version: candidate.version, launcher: candidate.launcher, baseVersion: saved?.baseVersion ?? currentVersion,
      ...((candidate.downgrade || saved?.allowDowngrade === true) ? { allowDowngrade: true } : {}), ...(previous ? { previous } : {}) });
  }
  return { path, before, after: await bytes(path) };
}
/** Restores the exact previous pointer only while the pointer is still the one we wrote. A pointer
 * that another client changed meanwhile is never overwritten. */
export async function rollbackSelection(selection) {
  const current = await bytes(selection.path);
  if (!current || !selection.after || !current.equals(selection.after)) return false;
  if (selection.before) await atomicBytes(selection.path, selection.before);
  else await unlink(selection.path).catch(error => { if (error?.code !== "ENOENT") throw error; });
  return true;
}
