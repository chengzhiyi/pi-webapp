import type { HostedMount, HostedViewIdentity, HostedViewRecovery } from "../../../contracts/hosted-plugins.ts";
import { hostedApi } from "./api.ts";

export interface UnconfirmedView extends HostedViewIdentity {
  viewToken: string; kind: HostedMount["kind"]; contentId?: string;
  /** Retained for recovery is deliberately different from acknowledged/saved. */
  retained?: boolean;
  frameStarted?: boolean;
  /** When this document wrote the record; absent on records from older builds. */
  createdAt?: number;
  /** Found in another window's durable journal; discovery is not consent to retire it. */
  discovered?: boolean;
  backups?: Array<{ key: string; name: string }>;
}
const key = "pi:hosted:unconfirmed-views:v1";
const recordPrefix = "pi:hosted:unconfirmed-view:v1:";
const retiredPrefix = "pi:hosted:retired-view:v1:";
let problem = "";
const unreadable = () => { problem = "View recovery journal could not be read. Its original data has been retained."; };
const unstored = () => { problem = "View recovery journal could not be stored. Keep this page open and download local drafts."; };
function validRecord(value: unknown): value is UnconfirmedView {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return ["controller", "workspace", "editor", "tool"].includes(String(record.kind))
    && ["sessionId", "pluginId", "mountId", "viewToken"].every(name => typeof record[name] === "string" && record[name].length > 0 && record[name].length <= 214)
    && Number.isSafeInteger(record.generation) && Number(record.generation) >= 1
    && (record.contentId === undefined || typeof record.contentId === "string")
    && (record.createdAt === undefined || Number.isSafeInteger(record.createdAt))
    && ["retained", "frameStarted"].every(name => record[name] === undefined || typeof record[name] === "boolean")
    && (record.backups === undefined || Array.isArray(record.backups) && record.backups.every(backup => backup && typeof backup.key === "string" && typeof backup.name === "string"));
}
function loadSession(): UnconfirmedView[] {
  try {
    if (typeof sessionStorage === "undefined") return [];
    const raw = sessionStorage.getItem(key);
    if (!raw) return [];
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || !value.every(validRecord)) throw new Error("Invalid view recovery journal");
    return value;
  } catch {
    // Keep the original bytes. A corrupt recovery journal must not crash ordinary chat
    // or be overwritten by new frame registrations.
    unreadable();
    return [];
  }
}
function durableRecord(token: string): UnconfirmedView | "retired" | null {
  if (typeof localStorage === "undefined") return null;
  const retirement = localStorage.getItem(retiredPrefix + token);
  if (retirement !== null) {
    if (JSON.parse(retirement) !== true) throw new Error("Invalid view retirement receipt");
    return "retired";
  }
  const raw = localStorage.getItem(recordPrefix + token);
  if (!raw) return null;
  const value: unknown = JSON.parse(raw);
  if (!validRecord(value) || value.viewToken !== token) throw new Error("Invalid durable view recovery record");
  return value;
}
function sameIdentity(a: HostedViewIdentity, b: HostedViewIdentity) {
  return a.sessionId === b.sessionId && a.pluginId === b.pluginId && a.generation === b.generation && a.mountId === b.mountId;
}
const sessionRecords = loadSession();
// Only tokens belonging to this top-level browsing session may be automatically
// cancelled before initialization. Never adopt foreign tokens on the next reload.
const ownTokens = new Set(sessionRecords.map(record => record.viewToken));
function loadDurable(): UnconfirmedView[] {
  const combined = new Map(sessionRecords.map(record => [record.viewToken, record]));
  try {
    if (typeof localStorage !== "undefined") for (let index = 0; index < localStorage.length; index++) {
      const storedKey = localStorage.key(index);
      const prefix = storedKey?.startsWith(recordPrefix) ? recordPrefix : storedKey?.startsWith(retiredPrefix) ? retiredPrefix : undefined;
      if (!prefix) continue;
      const token = storedKey!.slice(prefix.length);
      try {
        const record = durableRecord(token);
        if (record === "retired") combined.delete(token);
        else if (record) {
          const legacy = combined.get(token);
          if (legacy && !sameIdentity(legacy, record)) throw new Error("Conflicting view recovery identity");
          combined.set(token, { ...record, discovered: !ownTokens.has(token) });
        }
      } catch { unreadable(); }
    }
  } catch { unreadable(); }
  return [...combined.values()];
}
export const prior = loadDurable();
let records = [...prior];
/** Management may unmount; never revive records already confirmed closed. */
export function priorViews() {
  records = records.filter(record => {
    try { return durableRecord(record.viewToken) !== "retired"; }
    catch { unreadable(); return true; }
  });
  return records.filter(record => prior.some(item => item.viewToken === record.viewToken));
}
const recoveryCopies = new Map<string, string>();
const recoveryPrefix = "pi:hosted:recovery-draft:v1:";
export const recoveryJournalProblem = () => problem;
function saveSession() {
  if (problem) return false;
  try {
    if (typeof sessionStorage !== "undefined") sessionStorage.setItem(key, JSON.stringify(records.filter(record => ownTokens.has(record.viewToken))));
    return true;
  } catch { unstored(); return false; }
}
function persist(record: UnconfirmedView) {
  if (problem) return false;
  try {
    if (typeof localStorage === "undefined") return true;
    const current = durableRecord(record.viewToken);
    // A separate retirement key cannot be overwritten by a concurrent stale
    // record writer between its read and write. Keep the original record too.
    if (current === "retired") return false;
    if (current && !sameIdentity(current, record)) {
      throw new Error("Conflicting view recovery identity");
    }
    const { discovered: _discovered, ...stored } = { ...record,
      ...(current?.frameStarted ? { frameStarted: true } : {}), ...(current?.retained ? { retained: true } : {}),
      backups: [...new Map([...(current?.backups ?? []), ...(record.backups ?? [])].map(backup => [backup.key, backup])).values()] };
    localStorage.setItem(recordPrefix + record.viewToken, JSON.stringify(stored));
    return true;
  } catch { unstored(); return false; }
}
export function rememberView(identity: HostedViewIdentity, viewToken: string, mount: HostedMount) {
  ownTokens.add(viewToken);
  records = records.filter(record => record.viewToken !== viewToken);
  const record = { ...identity, viewToken, kind: mount.kind, contentId: mount.contentId, frameStarted: false, createdAt: Date.now() };
  records.push(record); persist(record); saveSession();
}
export function markViewConnecting(viewToken: string) {
  const record = records.find(record => record.viewToken === viewToken);
  if (!record || record.retained) return false;
  const connecting = { ...record, frameStarted: true };
  if (!persist(connecting)) return false;
  records = records.map(record => record.viewToken === viewToken ? connecting : record); return saveSession();
}
export function forgetView(viewToken: string) {
  records = records.filter(record => record.viewToken !== viewToken); ownTokens.delete(viewToken);
  try {
    // Read first so malformed original data is never replaced by a tombstone.
    durableRecord(viewToken);
    if (typeof localStorage !== "undefined") localStorage.setItem(retiredPrefix + viewToken, JSON.stringify(true));
  } catch { unreadable(); }
  saveSession();
}
export async function reconcileView(item: UnconfirmedView): Promise<HostedViewRecovery | undefined> {
  // Even RECONCILE can retire a controller or fence a not-yet-arrived REGISTER.
  // Another window must explicitly choose recovery for these uncertain records.
  if (item.discovered && (item.kind === "controller" || item.frameStarted !== true)) return undefined;
  const result = await hostedApi.view({ ...item, operation: "reconcile" });
  let state = result.recovery;
  if (state?.state === "unconfirmed" && item.frameStarted === false && ownTokens.has(item.viewToken)) {
    await hostedApi.view({ ...item, operation: "cancel-initialization" });
    forgetView(item.viewToken); state = { ...state, state: "retired" };
  }
  if (state?.state === "retired" || state?.state === "absent" && item.kind === "controller") forgetView(item.viewToken);
  return state;
}
/** A REGISTER request cannot still be in flight this long after its record was written. */
const settledMs = 5 * 60_000;
const goneCodes = new Set(["invalid_scope", "unknown_plugin"]);
const officialDrawing = "@chengzhiyi/pi-excalidraw";
function fingerprint(elements: unknown) {
  if (!Array.isArray(elements)) return undefined;
  const live = elements.filter(element => element && typeof element === "object" && !element.isDeleted)
    .map(element => [String(element.id), element.version, element.versionNonce]);
  return JSON.stringify(live.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}
/** True only when every local copy this record protects equals the drawing the host already saved. */
async function backupsSaved(item: UnconfirmedView, generation: number | undefined) {
  if (item.kind === "controller") return true;
  const drafts = recoveryDrafts(item);
  if (!drafts.length) return true;
  if (item.pluginId !== officialDrawing || generation === undefined) return false;
  for (const draft of drafts) {
    const id = /^recovery-(.+)\.excalidraw$/.exec(draft.name)?.[1];
    if (!id) return false;
    try {
      const saved = await hostedApi.action({ sessionId: item.sessionId, pluginId: item.pluginId, generation, action: "get", input: { id } }) as { scene?: { elements?: unknown } };
      const local = fingerprint(JSON.parse(draft.json).elements);
      if (!local || local !== fingerprint(saved?.scene?.elements)) return false;
    } catch { return false; }
  }
  return true;
}
/** Clear records that no longer protect anything, using only read-only probes.
 * Unlike RECONCILE this is safe for another window's records: live documents keep
 * polling, so "absent" or "stale" means no window remains to save, close or register
 * the view. Records whose local drawing copy differs from the saved drawing, and
 * records the user explicitly retained, always stay for an explicit decision. */
export async function settleView(item: UnconfirmedView, generation?: number, now = Date.now()): Promise<HostedViewRecovery | undefined> {
  if (item.retained) return { state: "retained" };
  const settled = item.frameStarted === true || item.createdAt === undefined || now - item.createdAt > settledMs;
  const retire = async () => {
    if (!await backupsSaved(item, generation)) return false;
    forgetView(item.viewToken); return true;
  };
  let state: HostedViewRecovery | undefined;
  try { state = (await hostedApi.view({ ...item, operation: "status" })).recovery; }
  catch (cause) {
    const code = (cause as { code?: unknown })?.code;
    // The session or plugin is gone, so the host holds no view that could still change.
    if (settled && typeof code === "string" && goneCodes.has(code) && await retire()) return { state: "retired" };
    // Older hosts have no STATUS; keep the original conservative reconciliation.
    if (cause instanceof Error && cause.message === "Unknown view operation") return reconcileView(item);
    throw cause;
  }
  if (state?.state === "retired") { forgetView(item.viewToken); return state; }
  if (state?.state === "absent") {
    if (settled && await retire()) return { state: "retired" };
    return settled || item.discovered ? state : reconcileView(item);
  }
  if (state?.state === "unconfirmed" && state.stale) {
    // Its document is gone. Controllers hold no authoring data; a clean view may close normally.
    if (item.kind === "controller") return reconcileView({ ...item, discovered: false });
    if (!state.dirty && !state.busy && await backupsSaved(item, generation)) {
      try { await hostedApi.view({ ...item, operation: "close" }); forgetView(item.viewToken); return { state: "retired" }; }
      catch { return state; }
    }
    return state;
  }
  if (state?.state === "unconfirmed" && !item.discovered) return reconcileView(item);
  return state;
}
export async function retainViewForRecovery(item: UnconfirmedView): Promise<void> {
  const result = await hostedApi.view({ ...item, operation: "recover", confirmation: "retain-unconfirmed-edits" });
  if (result.recovery?.state === "retired") { forgetView(item.viewToken); return; }
  if (!result.recovery || !["retained", "absent"].includes(result.recovery.state)) throw new Error("This view still has an active operation. Its recovery state was preserved.");
  records = records.map(record => record.viewToken === item.viewToken ? { ...record, retained: true } : record);
  const retained = records.find(record => record.viewToken === item.viewToken);
  if (retained) persist(retained);
  saveSession();
}
export async function discardView(item: UnconfirmedView): Promise<void> {
  const status = await hostedApi.view({ ...item, operation: "reconcile" });
  if (status.recovery?.state !== "absent") await hostedApi.view({ ...item, operation: "discard", confirmation: "discard-unconfirmed-edits" });
  forgetView(item.viewToken);
}
/** The existing official editor stores every scene change before attempting its network sync.
 * Exports are local recovery copies; reading one never applies it to a winning drawing.
 */
export function recoveryDrafts(item: UnconfirmedView): Array<{ name: string; json: string }> {
  if (item.pluginId !== "@chengzhiyi/pi-excalidraw") return [];
  const prefix = `pi-diagram:${item.sessionId}:`, drafts: Array<{ name: string; json: string }> = [];
  try {
    if (typeof localStorage === "undefined") return [];
    for (const backup of item.backups ?? []) {
      if (!backup.key.startsWith(`${recoveryPrefix}${item.viewToken}:`)) continue;
      const json = recoveryCopies.get(backup.key) ?? localStorage.getItem(backup.key);
      if (json) drafts.push({ name: backup.name, json });
    }
    if (drafts.length) return drafts;
    for (let index = 0; index < localStorage.length; index++) {
    const storageKey = localStorage.key(index);
    if (!storageKey?.startsWith(prefix) || item.contentId && storageKey !== prefix + item.contentId) continue;
    const json = localStorage.getItem(storageKey);
    if (!json || json.length > 16 * 1024 * 1024) continue;
    try {
      const scene = JSON.parse(json);
      if (!scene || !Array.isArray(scene.elements)) continue;
      const id = storageKey.slice(prefix.length).replace(/[^\w.-]/g, "_").slice(0, 100);
      drafts.push({ name: `recovery-${id}.excalidraw`, json });
    } catch { /* Preserve malformed backup bytes; never invent a replacement scene. */ }
  } } catch { /* Storage may be unavailable; other plugin and chat flows remain usable. */ }
  return drafts;
}

// Capture prior-document backups synchronously, before React mounts a new editor.
// The plugin's shared backup key may change as that editor adopts server state.
for (const item of prior) {
  if (item.kind === "controller") continue;
  const drafts = recoveryDrafts(item);
  if (!drafts.length) continue;
  item.backups = drafts.map(draft => {
    const key = `${recoveryPrefix}${item.viewToken}:${draft.name}`;
    recoveryCopies.set(key, draft.json);
    try { if (!localStorage.getItem(key)) localStorage.setItem(key, draft.json); }
    catch { problem = "Recovery copy could not be stored. Keep this page open and download local drafts before reloading."; }
    return { key, name: draft.name };
  });
}
for (const record of records) persist(record);
saveSession();
