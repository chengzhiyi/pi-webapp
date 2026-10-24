import { validateScene, type DiagramDraft, type DiagramScene } from "../contract/diagrams.ts";
import { HttpError } from "../../../../host/client/http-error.ts";
import { diagramAction } from "./api.ts";
const backupKey = (session: string, id: string) => `pi-diagram:${session}:${id}`;
export interface DiagramState { draft: DiagramDraft | null; scene: DiagramScene | null; unsynced: boolean; busy: boolean; error: string; recovered: DiagramScene | null }
/** Native scene is authoritative. Sync is serialized; old responses never replace newer hand edits. */
export class DiagramModel {
  private state: DiagramState = { draft: null, scene: null, unsynced: false, busy: false, error: "", recovered: null };
  private listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setTimeout>;
  private queue: Promise<unknown> = Promise.resolve();
  private version = 0;
  private fingerprint = "";
  private initializing = false;
  readonly sessionId: string;
  readonly id: string;
  constructor(sessionId: string, id: string) { this.sessionId = sessionId; this.id = id; }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private set(update: Partial<DiagramState>) { this.state = { ...this.state, ...update }; for (const l of this.listeners) l(); }
  private backup(scene: DiagramScene) {
    try { localStorage.setItem(backupKey(this.sessionId, this.id), JSON.stringify(scene)); }
    catch { this.set({ error: "浏览器草稿备份失败，请尽快保存或下载源文件。" }); }
  }
  async refresh(signal?: AbortSignal) {
    const version = this.version;
    try {
      const draft = await diagramAction<DiagramDraft>(this.sessionId, "get", { id: this.id }, signal);
      if (signal?.aborted || version !== this.version || this.state.busy || this.state.unsynced) return;
      if (!this.state.draft) {
        let recovered: DiagramScene | null = null;
        try { const raw = localStorage.getItem(backupKey(this.sessionId, this.id)); if (raw) { const backup = validateScene(JSON.parse(raw)); if (JSON.stringify(backup) !== JSON.stringify(draft.scene)) recovered = backup; } } catch { /* Invalid backup is never applied. */ }
        this.fingerprint = JSON.stringify(draft.scene);
        this.set({ draft, scene: draft.scene, recovered, error: "" });
      } else if (draft.revision !== this.state.draft.revision) {
        this.set({ error: "另一画布已更新此图稿；请下载本地草稿后重新载入，避免覆盖。" });
      } else this.set({ draft });
    } catch (error) { if (!signal?.aborted) this.set({ error: error instanceof Error ? error.message : String(error) }); }
  }
  change(scene: DiagramScene) {
    try {
      const valid = validateScene(scene), fingerprint = JSON.stringify(valid);
      if (fingerprint === this.fingerprint) return;
      this.fingerprint = fingerprint; this.version++;
      this.set({ scene: valid, unsynced: true }); this.backup(valid);
      clearTimeout(this.timer);
      this.timer = setTimeout(() => { void this.flush().catch(() => {}); }, 350);
    } catch (error) { this.set({ error: error instanceof Error ? error.message : String(error) }); }
  }
  async reload() {
    await this.queue.catch(() => {});
    const draft = await diagramAction<DiagramDraft>(this.sessionId, "get", { id: this.id });
    this.version++; this.fingerprint = JSON.stringify(draft.scene);
    this.set({ draft, scene: draft.scene, unsynced: false, error: "", recovered: null });
  }
  restore() { if (this.state.recovered) { const scene = this.state.recovered; this.set({ recovered: null }); this.change(scene); } }
  dismissRecovery() { this.set({ recovered: null }); }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.queue.catch(() => {}).then(operation);
    this.queue = work; return work;
  }
  private async sync() {
    while (this.state.unsynced) {
      const { draft, scene } = this.state;
      if (!draft || !scene) throw new Error("图稿未加载");
      const version = this.version;
      const next = await diagramAction<DiagramDraft>(this.sessionId, "sync", { id: this.id, revision: draft.revision, scene });
      this.set({ draft: next, unsynced: this.version !== version });
    }
  }
  flush() { clearTimeout(this.timer); return this.serial(async () => { try { await this.sync(); } catch (e) { this.set({ error: String(e instanceof Error ? e.message : e) }); throw e; } }); }
  async initialize(materialize: (scene: DiagramScene, candidate: NonNullable<DiagramDraft["candidate"]>) => DiagramScene) {
    const { draft, recovered, unsynced, busy } = this.state;
    if (this.initializing || !draft?.candidate || draft.revision !== 0 || draft.scene.elements.length || draft.candidate.patch || recovered || unsynced || busy) return;
    this.initializing = true;
    try { await this.mutate("initialize", { scene: materialize(draft.scene, draft.candidate) }); }
    catch (error) {
      // Another browser may have initialized the same new result. It is safe to read it only if
      // this client still has no local geometry, recovery data or unsynchronized user edits.
      if (error instanceof HttpError && error.status === 409 && !this.state.unsynced && !this.state.recovered && !this.state.scene?.elements.length) await this.reload();
      else throw error;
    }
    finally { this.initializing = false; }
  }
  async mutate(action: "save" | "accept" | "reject" | "initialize", extra: object = {}) {
    return this.serial(async () => {
      this.set({ busy: true, error: "" });
      try {
        await this.sync();
        const draft = this.state.draft!;
        const version = this.version;
        const next = await diagramAction<DiagramDraft>(this.sessionId, action, { id: this.id, revision: draft.revision, candidateId: draft.candidate?.id, ...extra });
        if (this.version === version) { this.fingerprint = JSON.stringify(next.scene); this.set({ scene: next.scene, unsynced: false }); }
        this.set({ draft: next });
        if ((action === "accept" || action === "initialize") && this.state.scene) this.backup(this.state.scene);
        if (action === "save" && !this.state.unsynced) localStorage.removeItem(backupKey(this.sessionId, this.id));
      } catch (error) { this.set({ error: error instanceof Error ? error.message : String(error) }); throw error; }
      finally { this.set({ busy: false }); }
    });
  }
  /** Keep the data model after tab close; its small native snapshot is also backed up locally. */
  suspend() { clearTimeout(this.timer); if (this.state.unsynced) void this.flush().catch(() => {}); }
}
/** Flush hand edits before the next main-chat prompt reaches the agent. */
export async function flushDiagramModels(sessionId: string) {
  await Promise.all([...models.values()].filter(m => m.sessionId === sessionId && m.getSnapshot().unsynced).map(m => m.flush()));
}
const models = new Map<string, DiagramModel>();
export function diagramModel(session: string, id: string) {
  const key = JSON.stringify([session, id]);
  let model = models.get(key); if (!model) { model = new DiagramModel(session, id); models.set(key, model); }
  return model;
}
