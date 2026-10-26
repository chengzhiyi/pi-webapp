import { mkdir, open, readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

/** Test-only old-format writer. No drawing validator/editor/domain is shipped by the host. */
export const legacyDraft = {
  id: "historical-draft", title: "旧图稿", revision: 0, savedRevision: null, path: null, diskHash: null, candidate: null,
  scene: { type: "excalidraw", version: 2, source: "pi-webapp", elements: [], appState: { viewBackgroundColor: "#ffffff" }, files: {} },
};
export const legacyFolder = (root: string, cwd: string, sessionId: string) => join(root, createHash("sha256").update(JSON.stringify([cwd, sessionId])).digest("hex"));
export async function writeLegacyCheckpoint(root: string, cwd: string, sessionId: string, draft: unknown = legacyDraft) {
  const folder = legacyFolder(root, cwd, sessionId);
  await mkdir(folder, {recursive:true});
  const lock = await open(join(folder,"scope.lock"),"wx",0o600);
  try {
    const marker = await readFile(join(folder,"hosted-migration.json")).catch((e: NodeJS.ErrnoException) => { if(e.code === "ENOENT") return null; throw e; });
    if (marker) throw Object.assign(new Error("Legacy writer fenced by migration"), {reason:"diagram_migrated"});
    await writeFile(join(folder,`${(draft as {id:string}).id}.json`),JSON.stringify({version:1,cwd,sessionId,draft}));
    await writeFile(join(folder,"focus.json"),JSON.stringify((draft as {id:string}).id));
  } finally { await lock.close(); await unlink(join(folder,"scope.lock")); }
  return structuredClone(draft) as typeof legacyDraft;
}
