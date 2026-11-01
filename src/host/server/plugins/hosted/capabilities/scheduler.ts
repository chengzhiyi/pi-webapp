import type { ScheduleDeclaration } from "./declarations.ts";

export interface SchedulerDeps {
  /** Runs one tick as a host-authenticated invocation; scope is resolved by the host, never the plugin. */
  invoke(pluginId: string, schedule: ScheduleDeclaration): Promise<unknown>;
  onError?(pluginId: string, schedule: ScheduleDeclaration, error: unknown): void;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}
/** Declarative timers: runs while the host runs, independent of any open panel. A tick is skipped while the previous one is still running. */
export class PluginScheduler {
  private readonly timers = new Map<string, unknown[]>();
  private readonly running = new Set<string>();
  private readonly deps: SchedulerDeps;
  constructor(deps: SchedulerDeps) { this.deps = deps; }
  start(pluginId: string, schedules: readonly ScheduleDeclaration[]): void {
    this.stop(pluginId);
    const set = this.deps.setInterval ?? ((fn, ms) => { const t = setInterval(fn, ms); t.unref(); return t; });
    this.timers.set(pluginId, schedules.map(s => set(() => void this.tick(pluginId, s), s.intervalSec * 1000)));
  }
  stop(pluginId: string): void {
    const clear = this.deps.clearInterval ?? ((h: unknown) => clearInterval(h as NodeJS.Timeout));
    for (const handle of this.timers.get(pluginId) ?? []) clear(handle);
    this.timers.delete(pluginId);
  }
  stopAll(): void { for (const id of [...this.timers.keys()]) this.stop(id); }
  async tick(pluginId: string, schedule: ScheduleDeclaration): Promise<boolean> {
    const key = `${pluginId}\0${schedule.id}`;
    if (this.running.has(key)) return false;
    this.running.add(key);
    try { await this.deps.invoke(pluginId, schedule); return true; }
    catch (error) { this.deps.onError?.(pluginId, schedule, error); return false; }
    finally { this.running.delete(key); }
  }
}
