import { createHash } from "node:crypto";
import { readdir, realpath, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { atomicJson, boundedRead, readJournal } from "../plugins/hosted/storage.ts";
import { HostedPluginError } from "../plugins/hosted/errors.ts";

export const pairRoot = (root: string) => join(root, "host-pair");
export const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Legacy schema-1 field. New hosts always write an empty list: plugins are never staged with the host. */
export interface PairSelection { id: string; version: string; digest: string; before: unknown }
/** Legacy host-switch journal (host-pair/intent.json). Hosts from 0.1.51 never start a switch here:
 * the launcher owns the upgrade transaction (bin/upgrade-transaction.mjs). They only read records left
 * by older hosts, settle them at startup, and keep the schema-1 encoding readable by those hosts.
 * An in-flight record older than PAIR_STALE_MS without progress counts as abandoned. */
export interface PairIntent {
  schema: 1; id: string; phase: "prepared" | "selecting" | "selected" | "restart-requested" | "reconciled" | "cancelled" | "required-action";
  version: string; packageRoot: string; hostDigest: string; fingerprint: string;
  selections: PairSelection[]; selection?: { path: string; digest: string }; message?: string;
  lifecyclePhase?: "cancelled" | "restart-requested" | "required-action";
  /** Last progress. Absent in records written before 0.1.51; the file time is used instead. */
  updatedAt?: string;
}
export const PAIR_STALE_MS = 10 * 60_000;
/** Fingerprint the staged application package, not dependency trees shared with npm peers.
 * No executable imports, symlinks, devices, unbounded file counts or unbounded reads. */
async function hostTree(root: string): Promise<string> {
  const hash = createHash("sha256"); let files = 0, bytes = 0;
  async function walk(relative: string): Promise<void> {
    const entries = (await readdir(join(root, relative), { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      if (!relative && entry.name === "node_modules") continue;
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink() || !entry.isFile() && !entry.isDirectory()) throw new HostedPluginError("host_pair_required", "Candidate package contains non-regular resources");
      if (++files > 10_000) throw new HostedPluginError("host_pair_required", "Candidate package resource budget exceeded");
      if (entry.isDirectory()) { await walk(path); continue; }
      const content = await boundedRead(join(root, path), 64 * 1024 * 1024);
      if (!content || (bytes += content.length) > 256 * 1024 * 1024) throw new HostedPluginError("host_pair_required", "Candidate package byte budget exceeded");
      hash.update(JSON.stringify([path, createHash("sha256").update(content).digest("hex")]));
    }
  }
  await walk(""); return hash.digest("hex");
}
export async function candidateHost(version: string, root: string): Promise<string> {
  // Read reviewed declarative metadata only. Never import or launch candidate code.
  const canonical = await realpath(root);
  const workerPath = join(root, "dist", "hosted-worker.js");
  if (await realpath(workerPath) !== join(canonical, "dist", "hosted-worker.js")) throw new HostedPluginError("host_pair_required", "Candidate worker must remain inside the staged host");
  const bytes = await boundedRead(join(root, "package.json"), 512 * 1024);
  if (!bytes) throw new HostedPluginError("host_pair_required", "Candidate package metadata missing");
  const pkg = JSON.parse(bytes.toString("utf8"));
  const contract = pkg.piWebappHostedRuntime;
  if (pkg.name !== "pi-webapp" || pkg.version !== version || contract?.protocol !== 2 || contract?.runtimeProtocol !== 1 ||
      contract?.pairJournal !== 1 || contract?.ownershipProtocol !== 2 || !Array.isArray(contract?.capabilities) ||
      !["state", "workspace", "legacy", "panels", "messages"].every(c => contract.capabilities.includes(c))) {
    throw new HostedPluginError("host_pair_required", "Candidate host lacks explicit hosted protocol/capability/pair-journal/crash-safe ownership metadata; retain current host or install a capable host");
  }
  const worker = await boundedRead(workerPath, 32 * 1024 * 1024);
  if (!worker) throw new HostedPluginError("host_pair_required", "Candidate worker missing");
  return fingerprint([bytes.toString("base64"), worker.toString("base64"), await hostTree(root)]);
}
/** Move an unreadable journal aside (bytes retained for diagnosis) so it can never brick updates. */
export async function quarantineJournal(path: string): Promise<void> {
  await rename(path, `${path}.corrupt-${Date.now()}`).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
}
const validIntent = (intent: PairIntent) => intent.schema === 1 && /^[a-f0-9-]{36}$/.test(intent.id) && typeof intent.version === "string" &&
  typeof intent.packageRoot === "string" && /^[a-f0-9]{64}$/.test(intent.hostDigest) &&
  /^[a-f0-9]{64}$/.test(intent.fingerprint) && Array.isArray(intent.selections) &&
  !intent.selections.some(p => !p || typeof p.id !== "string" || typeof p.version !== "string" || !/^[a-f0-9]{64}$/.test(p.digest) || !Object.hasOwn(p, "before")) &&
  !(intent.selection && (typeof intent.selection.path !== "string" || !/^[a-f0-9]{64}$/.test(intent.selection.digest))) &&
  ["prepared", "selecting", "selected", "restart-requested", "reconciled", "cancelled", "required-action"].includes(intent.phase);
export async function readPair(root: string): Promise<PairIntent | null> {
  const path = join(pairRoot(root), "intent.json");
  let intent: PairIntent | null, readable = true;
  try { intent = await readJournal<PairIntent>(path); } catch { intent = null; readable = false; }
  if (!readable || intent && !validIntent(intent)) {
    // An unreadable/foreign journal is quarantined, never a permanent update fence.
    await quarantineJournal(path); return null;
  }
  if (intent) {
    const { lifecyclePhase, ...record } = intent;
    const updatedAt = typeof record.updatedAt === "string" && !Number.isNaN(Date.parse(record.updatedAt)) ? record.updatedAt
      : await stat(path).then(info => info.mtime.toISOString(), () => new Date(0).toISOString());
    intent = { ...record, updatedAt, phase: record.phase === "selected" && lifecyclePhase === "restart-requested" ? "restart-requested"
      : record.phase === "reconciled" && lifecyclePhase === "cancelled" ? "cancelled"
      : record.phase === "reconciled" && lifecyclePhase === "required-action" ? "required-action" : record.phase };
  }
  return intent;
}
/** Keep schema-1's disk phase grammar readable by an older fallback host.
 * Additive lifecycle detail never makes rollback binaries reject the journal.
 * A settled required-action is stored as "reconciled": hosts up to 0.1.50 treat a raw
 * required-action as an in-flight update and refuse every later update, including the fix.
 */
export async function writePair(root: string, intent: PairIntent): Promise<void> {
  const { lifecyclePhase: _prior, ...record } = { ...intent, selections: [], updatedAt: new Date().toISOString() };
  const compatible = record.phase === "cancelled" ? { ...record, phase: "reconciled", lifecyclePhase: "cancelled" }
    : record.phase === "required-action" ? { ...record, phase: "reconciled", lifecyclePhase: "required-action" }
    : record.phase === "restart-requested" ? { ...record, phase: "selected", lifecyclePhase: "restart-requested" } : record;
  await atomicJson(join(pairRoot(root), "intent.json"), compatible);
}
/** Between pointer write and the selected host's admission. A settled required-action is history. */
export const inFlightPair = (intent: PairIntent | null) => intent && ["selecting", "selected", "restart-requested"].includes(intent.phase);
/** In flight and still making progress. An abandoned record never fences the next update. */
export const activePair = (intent: PairIntent | null, now = Date.now()) =>
  !!intent && !!inFlightPair(intent) && now - Date.parse(intent.updatedAt ?? "") < PAIR_STALE_MS;
