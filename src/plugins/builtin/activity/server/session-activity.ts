import type { ActivityDetail, ActivitySnapshot, ActivitySource, ActivityTarget } from "../contract/activity.ts";
import { BackgroundTasksActivityProvider } from "./background-tasks.ts";
import { SubagentsActivityProvider } from "./subagents.ts";
import { emptySnapshot, errorText, type ActivityEventBus, type ActivityProvider } from "./provider.ts";

/** Session-owned live model. Subscribers control refreshes; task execution stays package-owned. */
export class SessionActivity {
  private readonly providers: ActivityProvider[];
  private readonly listeners = new Set<(snapshot: ActivitySnapshot) => void>();
  private state = emptySnapshot();
  private signature = "";
  private refreshPromise: Promise<void> | null = null;
  private refreshQueued = false;
  private invalidateTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(bus: ActivityEventBus, sessionId: string) {
    const invalidate = () => this.invalidate();
    this.providers = [new BackgroundTasksActivityProvider(bus, sessionId, invalidate), new SubagentsActivityProvider(bus, invalidate)];
  }

  get snapshotValue() { return this.state; }

  private publish() {
    for (const listener of this.listeners) {
      try { listener(this.state); } catch { /* One detached stream must not break package EventBus delivery. */ }
    }
  }

  async refresh(): Promise<ActivitySnapshot> {
    if (this.closed) return this.state;
    if (this.refreshPromise) {
      this.refreshQueued = true;
      return this.refreshPromise.then(() => this.state);
    }
    this.refreshPromise = (async () => {
      do {
        this.refreshQueued = false;
        const results = await Promise.all(this.providers.map(async provider => {
          try { return await provider.read(); }
          catch (error) { return { provider: { source: provider.source, available: false, error: errorText(error) }, items: [] }; }
        }));
        const items = results.flatMap(result => result.items).sort((left, right) => (right.updatedAt ?? right.startedAt ?? 0) - (left.updatedAt ?? left.startedAt ?? 0));
        const providers = results.map(result => result.provider);
        const signature = JSON.stringify({ items, providers });
        const changed = signature !== this.signature;
        this.signature = signature;
        if (changed) this.state = { ...this.state, revision: this.state.revision + 1 };
        this.state = { ...this.state, observedAt: Date.now(), items, providers };
        if (changed) this.publish();
      } while (this.refreshQueued && !this.closed);
    })().finally(() => { this.refreshPromise = null; });
    return this.refreshPromise.then(() => this.state);
  }

  invalidate() {
    if (this.closed || this.listeners.size === 0 || this.invalidateTimer) return;
    this.invalidateTimer = setTimeout(() => {
      this.invalidateTimer = null;
      void this.refresh();
    }, 100);
  }

  subscribe(listener: (snapshot: ActivitySnapshot) => void): () => void {
    if (this.closed) return () => {};
    this.listeners.add(listener);
    if (!this.pollTimer) {
      void this.refresh();
      // print-mode SDK sessions do not receive every pi-subagents UI event.
      this.pollTimer = setInterval(() => { void this.refresh(); }, 5_000);
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
    };
  }

  private provider(source: ActivitySource): ActivityProvider {
    const provider = this.providers.find(candidate => candidate.source === source);
    if (!provider) throw new Error("Activity provider is unavailable");
    return provider;
  }

  detail(target: ActivityTarget): Promise<ActivityDetail> { return this.provider(target.source).detail(target.id); }

  async stop(target: ActivityTarget): Promise<ActivitySnapshot> {
    await this.provider(target.source).stop(target.id);
    return this.refresh();
  }

  async rerun(target: ActivityTarget): Promise<ActivitySnapshot> {
    const provider = this.provider(target.source);
    if (!provider.rerun) throw new Error("This activity cannot be rerun");
    await provider.rerun(target.id);
    return this.refresh();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.invalidateTimer) clearTimeout(this.invalidateTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.invalidateTimer = null;
    this.pollTimer = null;
    this.state = { ...this.state, closed: true };
    this.publish();
    this.listeners.clear();
    for (const provider of this.providers) provider.close();
  }
}
