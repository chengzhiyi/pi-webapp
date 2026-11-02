import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { atomicJson, boundedRead, readJournal, withStorageLock } from "../plugins/hosted/storage.ts";
import { HostedPluginError } from "../plugins/hosted/errors.ts";

export const pairRoot = (root: string) => join(root, "host-pair");
export const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Legacy schema-1 field. New hosts always write an empty list: plugins are never staged with the host. */
export interface PairSelection { id: string; version: string; digest: string; before: unknown }
/** Host-switch journal. It covers only the window from pointer write to the selected host's health
 * admission and carries no plugin state; anything older than PAIR_STALE_MS without progress is abandoned. */
export interface PairIntent {
  schema: 1; id: string; phase: "prepared" | "selecting" | "selected" | "restart-requested" | "reconciled" | "cancelled" | "required-action";
  version: string; packageRoot: string; hostDigest: string; fingerprint: string;
  selections: PairSelection[]; selection?: { path: string; digest: string }; message?: string;
  lifecyclePhase?: "cancelled" | "restart-requested" | "required-action";
  /** Last progress. Absent in records written before 0.1.51; the file time is used instead. */
  updatedAt?: string;
}
export const PAIR_STALE_MS = 10 * 60_000;
export interface HostedPairTransaction {
  stage?(version: string, packageRoot: string, signal?: AbortSignal): Promise<void>;
  cancel?(version?: string, packageRoot?: string, restoreSelection?: () => Promise<void>): Promise<void>;
  status?(): Promise<PairIntent | null>;
  select(version: string, packageRoot: string, writeSelection: () => Promise<void | { path: string; digest: string }>): Promise<void>;
  restart(version: string, packageRoot: string, writeRestart: () => Promise<void>): Promise<void>;
}
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
export const pendingPair = (intent: PairIntent | null) => intent && !["prepared", "reconciled", "cancelled"].includes(intent.phase);
/** Between pointer write and the selected host's admission. A settled required-action is history. */
export const inFlightPair = (intent: PairIntent | null) => intent && ["selecting", "selected", "restart-requested"].includes(intent.phase);
/** In flight and still making progress. An abandoned record never fences the next update. */
export const activePair = (intent: PairIntent | null, now = Date.now()) =>
  !!intent && !!inFlightPair(intent) && now - Date.parse(intent.updatedAt ?? "") < PAIR_STALE_MS;
export async function assertPairIdle(root: string): Promise<void> {
  const intent = await readPair(root);
  if (activePair(intent)) throw new HostedPluginError("host_pair_required", `Host switch to ${intent!.version} is in progress (${intent!.phase}); it is superseded automatically if it makes no progress for ${PAIR_STALE_MS / 60_000} minutes; data retained`);
}
/** The disk owner fence spans only candidate validation and the pointer write. Plugins are not part
 * of the transaction: `prefetch` may download plugin releases compatible with the target host into the
 * ordinary plugin store, best effort, and the selected host picks compatible versions per plugin. */
export function pairTransaction(root: string, prefetch: (version: string, signal?: AbortSignal) => Promise<void>, snapshot: () => Promise<unknown>): HostedPairTransaction {
  const retain = async (intent: PairIntent) => {
    const directory = join(pairRoot(root), "history");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await atomicJson(join(directory, `${intent.id}.json`), intent);
  };
  const supersede = async (previous: PairIntent | null) => {
    if (!previous) return;
    await retain(previous.phase === "prepared" ? { ...previous, phase: "cancelled", message: "Superseded before version selection; no code or data changed" }
      : inFlightPair(previous) ? { ...previous, phase: "cancelled", message: `Abandoned after no progress since ${previous.updatedAt}; superseded by a new update. Was: ${previous.message ?? previous.phase}` }
      : previous.phase === "required-action" ? { ...previous, message: `Superseded by a new update; ${previous.message ?? "no message"}` } : previous);
  };
  const prepareIntent = async (version: string, packageRoot: string, signal?: AbortSignal): Promise<PairIntent> => {
    const hostDigest = await candidateHost(version, packageRoot);
    try { await prefetch(version, signal); } catch { signal?.throwIfAborted(); /* Plugins never decide the host update. */ }
    signal?.throwIfAborted();
    return { schema: 1, id: randomUUID(), phase: "prepared", version, packageRoot, hostDigest, fingerprint: fingerprint(await snapshot()), selections: [] };
  };
  return {
    status: () => readPair(root),
    stage: (version, packageRoot, signal) => withStorageLock(pairRoot(root), async () => {
      await assertPairIdle(root);
      await supersede(await readPair(root));
      await writePair(root, await prepareIntent(version, packageRoot, signal));
    }),
    cancel: (version, packageRoot, restoreSelection) => withStorageLock(pairRoot(root), async () => {
      const intent = await readPair(root);
      if (!intent || intent.phase === "cancelled" || intent.phase === "reconciled") return;
      if (version && intent.version !== version || packageRoot && intent.packageRoot !== packageRoot) throw new HostedPluginError("host_pair_changed", "Another update owns this transaction");
      if (pendingPair(intent) && !restoreSelection) throw new HostedPluginError("host_pair_required", "Selected update requires its owned pointer recovery receipt before cancellation");
      await restoreSelection?.();
      // The caller restores an owned selected pointer before cancelling. Never restore plugin state.
      const cancelled: PairIntent = { ...intent, phase: "cancelled", message: "Update cancelled; current runtime and plugin data retained" };
      await writePair(root, cancelled); await retain(cancelled);
    }),
    select: (version, packageRoot, writeSelection) => withStorageLock(pairRoot(root), async () => {
      await assertPairIdle(root);
      const staged = await readPair(root);
      const reuse = staged?.phase === "prepared" && staged.version === version && staged.packageRoot === packageRoot;
      if (!reuse) await supersede(staged);
      const intent = reuse ? staged : await prepareIntent(version, packageRoot);
      // Only the candidate host itself can refuse selection; plugin state never does.
      if (await candidateHost(version, packageRoot) !== intent.hostDigest) {
        await writePair(root, { ...intent, phase: "cancelled", message: "Candidate host changed before selection; host pointer not written" });
        throw new HostedPluginError("host_pair_changed", "Candidate host changed before selection; host pointer not written");
      }
      // Ambiguous pointer write failures retain candidate and intent; never delete possibly selected code.
      await writePair(root, { ...intent, phase: "selecting" });
      const selection = await writeSelection();
      await writePair(root, { ...intent, phase: "selected", ...(selection ? { selection } : {}) });
    }),
    restart: (version, packageRoot, writeRestart) => withStorageLock(pairRoot(root), async () => {
      const selected = await readPair(root);
      if (!selected || selected.phase !== "selected" || selected.version !== version || selected.packageRoot !== packageRoot ||
          selected.hostDigest !== await candidateHost(version, packageRoot)) {
        throw new HostedPluginError("host_pair_changed", "Selected host changed; restart refused, inspect pair journal");
      }
      if (selected.selection && fingerprint((await readFile(selected.selection.path)).toString("base64")) !== selected.selection.digest) {
        throw new HostedPluginError("host_pair_changed", "Host selection pointer changed; restart refused");
      }
      await writePair(root, { ...selected, phase: "restart-requested", message: "Restart authorized; awaiting launcher receipt and selected host health admission" });
      await writeRestart();
    }),
  };
}
