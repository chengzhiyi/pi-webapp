import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { atomicJson, boundedRead, readJournal, withStorageLock } from "../plugins/hosted/storage.ts";
import { HostedPluginError } from "../plugins/hosted/errors.ts";

export const pairRoot = (root: string) => join(root, "host-pair");
export const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export interface PairSelection { id: string; version: string; digest: string; before: unknown }
export interface PairIntent {
  schema: 1; id: string; phase: "prepared" | "selecting" | "selected" | "reconciled" | "required-action";
  version: string; packageRoot: string; hostDigest: string; fingerprint: string;
  selections: PairSelection[]; selection?: { path: string; digest: string }; message?: string;
}
export interface HostedPairTransaction {
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
export async function readPair(root: string): Promise<PairIntent | null> {
  const intent = await readJournal<PairIntent>(join(pairRoot(root), "intent.json"));
  if (intent && (intent.schema !== 1 || typeof intent.id !== "string" || typeof intent.version !== "string" ||
      typeof intent.packageRoot !== "string" || !/^[a-f0-9]{64}$/.test(intent.hostDigest) ||
      !/^[a-f0-9]{64}$/.test(intent.fingerprint) || !Array.isArray(intent.selections) ||
      intent.selections.some(p => !p || typeof p.id !== "string" || typeof p.version !== "string" || !/^[a-f0-9]{64}$/.test(p.digest) || !Object.hasOwn(p, "before")) ||
      intent.selection && (typeof intent.selection.path !== "string" || !/^[a-f0-9]{64}$/.test(intent.selection.digest)) ||
      !["prepared", "selecting", "selected", "reconciled", "required-action"].includes(intent.phase))) {
    throw new HostedPluginError("host_pair_required", "Invalid host pair journal; preserve data and inspect intent.json with all owners stopped");
  }
  return intent;
}
export const pendingPair = (intent: PairIntent | null) => intent && !["reconciled"].includes(intent.phase);
export async function assertPairIdle(root: string): Promise<void> {
  const intent = await readPair(root);
  if (intent && pendingPair(intent)) throw new HostedPluginError("host_pair_required", `Host pair selection pending (${intent.version}, ${intent.phase}): ${intent.message ?? "restart selected host, or stop all owners and inspect host-pair/intent.json"}; data retained`);
}
/** A disk owner fence spans preparation, revalidation and pointer selection. The journal then
 * fences management across the process exit; abandoned locks are never reclaimed by PID. */
export function pairTransaction(root: string, prepare: (version: string) => Promise<PairSelection[]>, snapshot: () => Promise<unknown>, validate: (version: string, selections: PairSelection[]) => Promise<void> = async () => {}): HostedPairTransaction {
  return {
    select: (version, packageRoot, writeSelection) => withStorageLock(pairRoot(root), async () => {
      await assertPairIdle(root);
      const hostDigest = await candidateHost(version, packageRoot);
      const before = fingerprint(await snapshot());
      const selections = await prepare(version);
      if (fingerprint(await snapshot()) !== before) throw new HostedPluginError("host_pair_changed", "Plugin policy/activation changed during preflight; recheck update");
      const intent: PairIntent = { schema: 1, id: randomUUID(), phase: "prepared", version, packageRoot, hostDigest, fingerprint: before, selections };
      await atomicJson(join(pairRoot(root), "intent.json"), intent);
      await validate(version, selections);
      if (await candidateHost(version, packageRoot) !== hostDigest || fingerprint(await snapshot()) !== before) {
        await atomicJson(join(pairRoot(root), "intent.json"), { ...intent, phase: "required-action", message: "Preflight changed; host pointer not written" });
        throw new HostedPluginError("host_pair_changed", "Preflight changed; host pointer not written");
      }
      // Ambiguous pointer write failures retain candidate and intent; never delete possibly selected code.
      await atomicJson(join(pairRoot(root), "intent.json"), { ...intent, phase: "selecting" });
      const selection = await writeSelection();
      await atomicJson(join(pairRoot(root), "intent.json"), { ...intent, phase: "selected", ...(selection ? { selection } : {}) });
    }),
    restart: (version, packageRoot, writeRestart) => withStorageLock(pairRoot(root), async () => {
      const intent = await readPair(root);
      if (!intent || intent.phase !== "selected" || intent.version !== version || intent.packageRoot !== packageRoot ||
          intent.hostDigest !== await candidateHost(version, packageRoot) || intent.fingerprint !== fingerprint(await snapshot())) {
        throw new HostedPluginError("host_pair_changed", "Selected pair changed; restart refused, inspect pair journal");
      }
      if (intent.selection && fingerprint((await readFile(intent.selection.path)).toString("base64")) !== intent.selection.digest) {
        throw new HostedPluginError("host_pair_changed", "Host selection pointer changed; restart refused");
      }
      await validate(version, intent.selections);
      if (intent.hostDigest !== await candidateHost(version, packageRoot) || intent.fingerprint !== fingerprint(await snapshot())) {
        throw new HostedPluginError("host_pair_changed", "Selected pair changed during restart validation");
      }
      await writeRestart();
    }),
  };
}
