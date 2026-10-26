import { open, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { HostedInvocation } from "@chengzhiyi/pi-web-protocol";
import { HostedPluginError } from "./errors.ts";
import { sha256 } from "./resources.ts";
import { atomicJson, privateDirectory, readJson } from "./storage.ts";

export const LEGACY_MIGRATION_MARKER = "hosted-migration.json";
/** Domain validation remains in the plugin. Host verifies scope, envelope, filenames and budgets.
 * A durable marker under the SAME cooperative lock stops the current built-in writer before import.
 * Old binaries that predate this marker must be stopped before migration; this is not an OS sandbox.
 */
export function legacyCheckpointLoader(root: string, pluginId = "@chengzhiyi/pi-excalidraw") {
  return async (request: HostedInvocation): Promise<unknown> => {
    const { cwd, sessionId } = request.scope;
    const folder = join(root, sha256(JSON.stringify([cwd, sessionId])));
    await privateDirectory(root); await privateDirectory(folder);
    const path = join(folder, "scope.lock");
    let lock;
    try { lock = await open(path, "wx", 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new HostedPluginError("legacy_busy", "Legacy drawing writer is active or needs explicit lock recovery", { status: 409 }); throw error; }
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, operationId: randomUUID() }));
      const marker = await readJson<{ version: number; pluginId: string }>(join(folder, LEGACY_MIGRATION_MARKER));
      if (marker && (marker.version !== 1 || marker.pluginId !== pluginId)) throw new HostedPluginError("invalid_storage", "Legacy scope belongs to another migration");
      const names = await readdir(folder);
      const drafts: unknown[] = [];
      for (const name of names) {
        if (name === "scope.lock" || name === "focus.json" || name === LEGACY_MIGRATION_MARKER) continue;
        // Legacy atomic writes may leave .tmp files after a crash. Preserve but never import them.
        if (/^[\w-]{1,80}\.json\.[a-f0-9-]{36}\.tmp$/.test(name)) continue;
        if (!/^[\w-]{1,80}\.json$/.test(name)) throw new HostedPluginError("invalid_storage", "Unexpected legacy checkpoint member; original bytes preserved");
        if (drafts.length >= 100) throw new HostedPluginError("invalid_storage", "Too many legacy checkpoints");
        const envelope = await readJson<{ version: number; cwd: string; sessionId: string; draft: { id?: unknown } }>(join(folder, name), 3 * 512 * 1024);
        if (!envelope || envelope.version !== 1 || envelope.cwd !== cwd || envelope.sessionId !== sessionId || !envelope.draft || name !== `${envelope.draft.id}.json`) throw new HostedPluginError("invalid_storage", "Legacy checkpoint scope or identity mismatch");
        drafts.push(envelope.draft);
      }
      const focused = await readJson<unknown>(join(folder, "focus.json"), 1024);
      if (focused !== null && (typeof focused !== "string" || !drafts.some(d => (d as { id?: unknown }).id === focused))) throw new HostedPluginError("invalid_storage", "Invalid legacy focused drawing");
      // Marker is non-destructive and retryable. Even empty scopes cannot regain a second writer.
      if (!marker) await atomicJson(join(folder, LEGACY_MIGRATION_MARKER), { version: 1, pluginId, operationId: request.requestId });
      return { drafts, focused };
    } finally { await lock.close(); await unlink(path); }
  };
}
