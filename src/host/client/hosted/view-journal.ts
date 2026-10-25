import type { HostedMount, HostedViewIdentity } from "../../../contracts/hosted-plugins.ts";
interface UnconfirmedView extends HostedViewIdentity { viewToken: string; kind: HostedMount["kind"]; contentId?: string }
const key = "pi:hosted:unconfirmed-views:v1";
function load(): UnconfirmedView[] {
  if (typeof sessionStorage === "undefined") return [];
  const raw = sessionStorage.getItem(key);
  if (!raw) return [];
  const records = JSON.parse(raw);
  if (!Array.isArray(records)) throw new Error("Invalid hosted view recovery journal; keep this tab for recovery");
  return records;
}
export const prior = load();
let records = [...prior];
function save() { if (typeof sessionStorage !== "undefined") sessionStorage.setItem(key, JSON.stringify(records)); }
export function rememberView(identity: HostedViewIdentity, viewToken: string, mount: HostedMount) {
  records.push({ ...identity, viewToken, kind: mount.kind, contentId: mount.contentId }); save();
}
export function forgetView(viewToken: string) { records = records.filter(record => record.viewToken !== viewToken); save(); }

