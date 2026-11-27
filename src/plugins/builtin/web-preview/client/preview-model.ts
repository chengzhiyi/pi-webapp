import { randomUUID } from "../../../../host/client/random-uuid.ts";
import type { Action, Bounds, State, WebPreviewDesktop } from "./desktop-api.ts";

type Snapshot = { state: State; draft: string | null; submitted: string; pending: boolean; ipcFailed: boolean };
const idle: State = { status: "idle", url: "", canGoBack: false, canGoForward: false };

/** Owned by the workbench tab, not by a particular mount of the panel. */
export class PreviewModel {
  private readonly id = randomUUID();
  private readonly listeners = new Set<() => void>();
  private snapshot: Snapshot = { state: idle, draft: null, submitted: "", pending: false, ipcFailed: false };
  private unsubscribe?: () => void;
  private revision = 0;
  private disposed = false;
  constructor(private readonly api: WebPreviewDesktop) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  getSnapshot = () => this.snapshot;
  private update(patch: Partial<Snapshot>) {
    if (this.disposed) return;
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  edit(value: string) { this.update({ draft: value }); }
  open(raw: string) { return this.run(() => this.api.open(this.id, raw), { draft: null, submitted: raw }); }
  command(action: Action) { return this.run(() => this.api.command(this.id, action)); }

  private async run(request: () => Promise<State>, patch?: Partial<Snapshot>) {
    if (this.disposed || this.snapshot.pending) return false;
    this.update({ ...patch, pending: true, ipcFailed: false });
    try {
      this.unsubscribe ??= this.api.onState((id, state) => {
        if (id !== this.id || this.disposed) return;
        this.revision++;
        this.update({ state });
      });
      const revision = this.revision;
      const state = await request();
      // A completion event can arrive before the IPC reply's earlier snapshot.
      if (this.revision === revision) this.update({ state });
      return true;
    } catch {
      // Do not expose raw IPC errors (which may contain local paths or URLs).
      if (patch && this.snapshot.draft === null && !this.disposed) this.update({ draft: this.snapshot.submitted });
      this.update({ ipcFailed: true });
      return false;
    } finally {
      this.update({ pending: false });
    }
  }

  layout(bounds: Bounds | null) {
    if (this.disposed) return;
    try { this.api.layout(this.id, bounds); } catch { /* The desktop bridge may be gone. */ }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    try { this.unsubscribe?.(); } catch { /* The desktop bridge may be gone. */ }
    try { this.api.close(this.id); } catch { /* The desktop bridge may be gone. */ }
    this.listeners.clear();
  }
}
