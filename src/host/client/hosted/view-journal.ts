import type { HostedMount, HostedViewIdentity, HostedViewRecovery } from "../../../contracts/hosted-plugins.ts";
import { hostedApi } from "./api.ts";

export interface UnconfirmedView extends HostedViewIdentity {
  viewToken: string; kind: HostedMount["kind"]; contentId?: string;
  /** Retained for recovery is deliberately different from acknowledged/saved. */
  retained?: boolean;
  frameStarted?: boolean;
  backups?: Array<{ key: string; name: string }>;
}
const key = "pi:hosted:unconfirmed-views:v1";
let problem = "";
function load(): UnconfirmedView[] {
  if (typeof sessionStorage === "undefined") return [];
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return [];
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || value.some(record => !record || typeof record !== "object"
      || !["controller", "workspace", "editor", "tool"].includes(record.kind)
      || !["sessionId", "pluginId", "mountId", "viewToken"].every(name => typeof record[name] === "string" && record[name].length > 0 && record[name].length <= 214)
      || !Number.isSafeInteger(record.generation) || record.generation < 1)) throw new Error("Invalid view recovery journal");
    return value;
  } catch {
    // Keep the original bytes. A corrupt recovery journal must not crash ordinary chat
    // or be overwritten by new frame registrations.
    problem = "View recovery journal could not be read. Its original data has been retained.";
    return [];
  }
}
export const prior = load();
let records = [...prior];
const recoveryCopies = new Map<string, string>();
const recoveryPrefix = "pi:hosted:recovery-draft:v1:";
export const recoveryJournalProblem = () => problem;
function save() {
  if (typeof sessionStorage === "undefined") return true;
  if (problem) return false;
  try { sessionStorage.setItem(key, JSON.stringify(records)); return true; }
  catch { problem = "View recovery journal could not be stored. Keep this page open and download local drafts."; return false; }
}
export function rememberView(identity: HostedViewIdentity, viewToken: string, mount: HostedMount) {
  records = records.filter(record => record.viewToken !== viewToken);
  records.push({ ...identity, viewToken, kind: mount.kind, contentId: mount.contentId, frameStarted: false }); save();
}
export function markViewConnecting(viewToken: string) {
  records = records.map(record => record.viewToken === viewToken ? { ...record, frameStarted: true } : record); return save();
}
export function forgetView(viewToken: string) { records = records.filter(record => record.viewToken !== viewToken); save(); }
export async function reconcileView(item: UnconfirmedView): Promise<HostedViewRecovery | undefined> {
  const result = await hostedApi.view({ ...item, operation: "reconcile" });
  let state = result.recovery;
  if (state?.state === "unconfirmed" && item.frameStarted === false) {
    await hostedApi.view({ ...item, operation: "cancel-initialization" });
    forgetView(item.viewToken); state = { ...state, state: "retired" };
  }
  if (state?.state === "retired" || state?.state === "absent" && item.kind === "controller") forgetView(item.viewToken);
  return state;
}
export async function retainViewForRecovery(item: UnconfirmedView): Promise<void> {
  const result = await hostedApi.view({ ...item, operation: "recover", confirmation: "retain-unconfirmed-edits" });
  if (!result.recovery || !["retained", "absent"].includes(result.recovery.state)) throw new Error("This view still has an active operation. Its recovery state was preserved.");
  records = records.map(record => record.viewToken === item.viewToken ? { ...record, retained: true } : record); save();
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
  if (item.pluginId !== "@chengzhiyi/pi-excalidraw" || typeof localStorage === "undefined") return [];
  const prefix = `pi-diagram:${item.sessionId}:`, drafts: Array<{ name: string; json: string }> = [];
  try {
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
    try { localStorage.setItem(key, draft.json); }
    catch { problem = "Recovery copy could not be stored. Keep this page open and download local drafts before reloading."; }
    return { key, name: draft.name };
  });
}
save();
