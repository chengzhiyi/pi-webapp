import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { DiagramError, MAX_SCENE_BYTES, identifier, label, record, validateDrawing, validateGraph, validatePatch, validateScene, type DiagramDraft } from "../contract/diagrams.ts";
import { DiagramStore } from "./store.ts";

const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const MAX_RECORD = 3 * MAX_SCENE_BYTES;
async function read(path: string, limit = MAX_RECORD): Promise<string | null> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0)); }
  catch (e) { if (missing(e)) return null; throw e; }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error("Invalid diagram checkpoint size or type");
    const bytes = Buffer.alloc(limit + 1); let length = 0;
    while (length < bytes.length) { const { bytesRead } = await file.read(bytes, length, bytes.length - length, length); if (!bytesRead) break; length += bytesRead; }
    if (length > limit) throw new Error("Oversized diagram checkpoint");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
  } finally { await file.close(); }
}
async function directory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Diagram storage must be a real directory");
}
async function atomic(path: string, text: string) {
  const temp = `${path}.${randomUUID()}.tmp`;
  const file = await open(temp, "wx", 0o600);
  try {
    try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
    await rename(temp, path);
  } finally { await unlink(temp).catch(() => {}); }
}
function draftRecord(value: unknown): DiagramDraft {
  if (!record(value)) throw new Error("Invalid checkpoint");
  const id = identifier(value.id), title = label(value.title), scene = validateScene(value.scene);
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0 ||
    !(value.savedRevision === null || (Number.isSafeInteger(value.savedRevision) && (value.savedRevision as number) >= 0 && (value.savedRevision as number) <= (value.revision as number))) ||
    !(value.path === null || (typeof value.path === "string" && value.path.length <= 4096)) ||
    !(value.diskHash === null || (typeof value.diskHash === "string" && /^[a-f0-9]{64}$/.test(value.diskHash)))) throw new Error("Invalid checkpoint metadata");
  const draft: DiagramDraft = { id, title, scene, revision: value.revision as number, savedRevision: value.savedRevision as number | null, path: value.path as string | null, diskHash: value.diskHash as string | null, candidate: null };
  if (value.candidate !== null) {
    const candidate = value.candidate;
    if (!record(candidate) || !Number.isSafeInteger(candidate.baseRevision) || (candidate.baseRevision as number) < 0 || (candidate.baseRevision as number) > draft.revision || [candidate.elements, candidate.graph, candidate.patch].filter(v => v !== undefined).length !== 1) throw new Error("Invalid checkpoint candidate");
    draft.candidate = { id: identifier(candidate.id), baseRevision: candidate.baseRevision as number,
      ...(candidate.elements === undefined ? {} : { elements: validateDrawing(candidate.elements) }),
      ...(candidate.graph === undefined ? {} : { graph: validateGraph(candidate.graph) }),
      // A stale patch remains rejectable after hand edits. Validation against the old scene
      // already happened at creation; never try to apply it during recovery.
      ...(candidate.patch === undefined ? {} : { patch: candidate.baseRevision === draft.revision ? validatePatch(candidate.patch, scene) : record(candidate.patch) ? structuredClone(candidate.patch) : (() => { throw new Error("Invalid checkpoint patch"); })() }),
    };
  }
  return draft;
}

/** Durable, local checkpoints are distinct from user-exported .excalidraw files.
 * Hash both workspace and session; never use model IDs or session text as paths.
 * A scope lock serializes bridge instances, including read/modify/write revision checks.
 * Each transaction reloads disk state so a second bridge cannot overwrite stale data.
 */
export class PersistentDiagramStore {
  private root: string;
  constructor(root = join(getAgentDir(), "pi-web", "diagrams")) { this.root = root; }
  private async lock(folder: string) {
    const path = join(folder, "scope.lock");
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const file = await open(path, "wx", 0o600);
        try { await file.writeFile(JSON.stringify({ pid: process.pid })); } catch (e) { await file.close(); await unlink(path); throw e; }
        return async () => { await file.close(); await unlink(path); };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        // Do not auto-unlink even an apparently dead PID's lock: PID reuse and
        // competing reclaimers could otherwise delete a new owner's lock. After
        // an unclean kill, an operator must stop writers before removing this lock.
        await delay(20);
      }
    }
    throw new DiagramError("图稿存储正忙，请稍后重试；未覆盖图稿", 409);
  }
  private async run<T>(cwd: string, sessionId: string, operation: (store: DiagramStore) => T | Promise<T>): Promise<T> {
    let release: (() => Promise<void>) | undefined;
    let executing = false;
    try {
      await directory(this.root);
      const folder = join(this.root, digest(JSON.stringify([cwd, sessionId])));
      await directory(folder); release = await this.lock(folder);
      // The hosted importer writes this marker under scope.lock before releasing the legacy snapshot.
      // Refuse all later built-in access: imports must never create a second checkpoint writer.
      if (await read(join(folder, "hosted-migration.json"), 2048)) throw new DiagramError("图稿已迁移至外置 Excalidraw 插件；请安装或启用该插件恢复", 409, "diagram_migrated");
      const names = (await readdir(folder)).filter(name => /^[\w-]{1,80}\.json$/.test(name) && name !== "focus.json");
      if (names.length > 100) throw new Error("Too many diagram checkpoints");
      const drafts: DiagramDraft[] = [], before = new Map<string, string>();
      for (const name of names) {
        const raw = await read(join(folder, name));
        if (!raw) throw new Error("Missing diagram checkpoint");
        const envelope: unknown = JSON.parse(raw);
        if (!record(envelope) || envelope.version !== 1 || envelope.cwd !== cwd || envelope.sessionId !== sessionId) throw new Error("Checkpoint scope mismatch");
        const draft = draftRecord(envelope.draft);
        if (name !== `${draft.id}.json`) throw new Error("Checkpoint ID mismatch");
        drafts.push(draft); before.set(draft.id, JSON.stringify(draft));
      }
      const focusRaw = await read(join(folder, "focus.json"), 1024);
      const focused: unknown = focusRaw ? JSON.parse(focusRaw) : null;
      const store = new DiagramStore();
      store.restoreCheckpoint(cwd, sessionId, { drafts, focused: typeof focused === "string" && drafts.some(d => d.id === focused) ? focused : null });
      executing = true;
      const result = await operation(store), next = store.checkpoint(cwd, sessionId);
      executing = false;
      for (const draft of next.drafts) {
        const serialized = JSON.stringify(draft);
        if (serialized !== before.get(draft.id)) {
          const bytes = JSON.stringify({ version: 1, cwd, sessionId, draft });
          if (Buffer.byteLength(bytes) > MAX_RECORD) throw new Error("Oversized diagram checkpoint");
          await atomic(join(folder, `${identifier(draft.id)}.json`), bytes);
        }
      }
      if (next.focused !== focused) await atomic(join(folder, "focus.json"), JSON.stringify(next.focused));
      return result;
    } catch (e) {
      if (e instanceof DiagramError && (executing || e.status === 409)) throw e;
      throw new DiagramError("图稿本地存储读取或写入失败；原数据未被自动清空，请保留草稿后重试", 500, "diagram_storage_error");
    } finally { await release?.(); }
  }
  tool(cwd: string, sessionId: string, action: string, input: unknown) {
    // Reading the format guide requires no disk IO or new state.
    if (action === "reference") return Promise.resolve(new DiagramStore().tool(cwd, sessionId, action, input));
    return this.run(cwd, sessionId, store => store.tool(cwd, sessionId, action, input));
  }
  action(cwd: string, sessionId: string, action: string, input: Record<string, unknown>, guard: () => void) {
    return this.run(cwd, sessionId, async store => { guard(); const result = await store.action(cwd, sessionId, action, input, guard); guard(); return result; });
  }
}
