// Desktop shell escape route: clear business-package upgrade state and fall back to the bundled
// version. It is the most stable layer and depends on nothing the business package ships, so it
// works even when an installed package's own update logic is broken. Records are moved aside into
// a timestamped folder with a receipt, never deleted. Plugin code and data, chats and settings are
// not touched.
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Every file that can select, stage or fence a business-package switch, relative to pi-web/. */
export const upgradeStateFiles = [
  "desktop-update.json",            // selected business package (removing it falls back to the bundle)
  "update-transaction.json",        // host-side download/validation record
  "upgrade/candidate.json",         // validated candidate awaiting the launcher
  "upgrade/transaction.json",       // launcher-owned switch record
  "launcher.restart",               // pending restart request
  "launcher-handoff.json",          // launcher handoff receipt
  "desktop-handoff.json",           // desktop handoff intent
  "hosted/host-pair/intent.json",   // legacy host-pair journal (fences updates in hosts up to 0.1.50)
];

export async function resetUpgradeState(agentDir, now = new Date()) {
  const base = join(agentDir, "pi-web");
  const folder = join(base, "upgrade-reset", now.toISOString().replace(/[:.]/g, "-"));
  const moved = [];
  for (const relative of upgradeStateFiles) {
    const target = join(folder, relative.replaceAll("/", "__"));
    try {
      await mkdir(folder, { recursive: true, mode: 0o700 });
      await rename(join(base, relative), target);
      moved.push(relative);
    } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  if (moved.length) await writeFile(join(folder, "receipt.json"), JSON.stringify({ version: 1, resetAt: now.toISOString(), moved }), { mode: 0o600 });
  return { folder: moved.length ? folder : null, moved };
}
