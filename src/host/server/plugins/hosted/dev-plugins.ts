import { resolve } from "node:path";
import type { OfficialPlugin } from "./official-catalog.ts";

export const GITHUB_ID = "@chengzhiyi/pi-github";
/** Catalog metadata for plugins that exist only as developer-supplied archives (no registry listing yet). */
const KNOWN: Record<string, OfficialPlugin> = {
  [GITHUB_ID]: {
    id: GITHUB_ID, name: "GitHub",
    description: { zh: "把 GitHub issue 交给 agent：先出方案，经你批准后实现并提交草稿 PR。", en: "Hand GitHub issues to an agent: it plans, you approve, then it implements and opens a draft PR." },
    registry: "https://registry.npmjs.org", recommendedVersion: "0.1.0",
    requiredCapabilities: ["state", "panels", "scheduler", "network", "secrets", "sessions"],
  },
};
/** `PI_WEBAPP_HOSTED_DEV_ARCHIVES="<id>=<path.tgz>;<id>=<path.tgz>"`. Unknown ids are rejected rather than trusted. */
export function devPluginsFromEnv(value = process.env.PI_WEBAPP_HOSTED_DEV_ARCHIVES): { catalog: OfficialPlugin[]; archives: Map<string, string> } {
  const catalog: OfficialPlugin[] = [], archives = new Map<string, string>();
  for (const part of (value ?? "").split(/[;\n]/).map(s => s.trim()).filter(Boolean)) {
    const eq = part.lastIndexOf("="), id = part.slice(0, eq), file = part.slice(eq + 1);
    const known = KNOWN[id];
    if (eq < 1 || !known || !file.endsWith(".tgz")) { console.error(`PI_WEBAPP_HOSTED_DEV_ARCHIVES: ignoring invalid entry "${part}"`); continue; }
    catalog.push(known); archives.set(id, resolve(file));
  }
  return { catalog, archives };
}
