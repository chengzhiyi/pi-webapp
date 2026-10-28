import { randomUUID } from "node:crypto";
import { acquireStorageOwnership } from "./storage.ts";
import type { HostedInvocation, HostedToolDescriptor } from "@chengzhiyi/pi-web-protocol";
import type { HostedPackage } from "./resources.ts";
import { HostedRuntimeProcess } from "./runtime-process.ts";
import { HostedStateBroker, type ActiveHostedPlugin } from "./state-broker.ts";
import { HostedPluginError } from "./errors.ts";

export interface HostedSwitchHooks {
  /** Pure precommit policy/ownership validation against the VERIFIED candidate, never the old worker. */
  validateCandidate?(tools: readonly HostedToolDescriptor[]): void | Promise<void>;
  /** False while an editor is open, composing, dragging or otherwise cannot preserve its state. */
  canSwitch(): boolean | Promise<boolean>;
  /** All affected clients and tool batches must reach a safe boundary, flush and freeze, or fail. */
  freeze(): Promise<void>;
  /** Reconnect frames and atomically publish tool descriptions; old-generation writes are already fenced. */
  committed(active: ActiveHostedPlugin): Promise<void>;
  /** Resume the old generation after a failed preparation. */
  resume(): Promise<void>;
}
export type HostedRuntimePhase = "disabled" | "starting" | "active" | "draining" | "switching" | "failed";
const noViews: HostedSwitchHooks = { canSwitch: () => true, freeze: async () => {}, committed: async () => {}, resume: async () => {} };
/** Owns one plugin's routing. It never reloads the host or creates an AgentSession. */
export class HostedPluginSupervisor {
  private worker: HostedRuntimeProcess | null = null;
  private operations: Promise<unknown> = Promise.resolve();
  private phaseValue: HostedRuntimePhase = "disabled";
  private pendingPackage: HostedPackage | null = null;
  private releaseOwnership: (() => Promise<void>) | null = null;
  readonly broker: HostedStateBroker;
  private readonly workerEntry: string;
  private readonly hooks: HostedSwitchHooks;
  constructor(broker: HostedStateBroker, workerEntry: string, hooks: HostedSwitchHooks = noViews) {
    this.broker = broker; this.workerEntry = workerEntry; this.hooks = hooks;
  }
  get phase(): HostedRuntimePhase { return this.phaseValue; }
  get pid(): number | undefined { return this.worker?.pid; }
  get tools() { return this.worker?.tools ?? []; }
  get pendingVersion(): string | null { return this.pendingPackage?.version ?? null; }
  get generation(): number | null { return this.worker?.generation ?? null; }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation, operation);
    this.operations = result.catch(() => {});
    return result;
  }
  private async ownRuntime(): Promise<void> {
    if (this.releaseOwnership) return;
    const release = await acquireStorageOwnership(this.broker.root, "runtime");
    this.releaseOwnership = async () => { await release(); this.releaseOwnership = null; };
  }
  private callBroker = (request: HostedInvocation, method: string, input: unknown) => this.broker.call(request, method, input);
  invoke(request: Omit<HostedInvocation, "generation">, timeoutMs?: number): Promise<unknown> {
    if (this.phaseValue !== "active" || !this.worker) return Promise.reject(new HostedPluginError("plugin_unavailable", "Plugin is disabled or waiting at a safe switch boundary"));
    return this.worker.invoke({ ...request, generation: this.worker.generation }, timeoutMs);
  }
  /** Host-only FlushBarrier admission. Never expose this as an unrestricted browser/tool endpoint. */
  flushAction(request: Omit<HostedInvocation, "generation" | "kind">, timeoutMs?: number): Promise<unknown> {
    if (!this.worker || !["active", "draining"].includes(this.phaseValue)) return Promise.reject(new HostedPluginError("plugin_unavailable", "No plugin is available for checkpoint synchronization"));
    return this.worker.invoke({ ...request, kind: "action", generation: this.worker.generation }, timeoutMs);
  }
  replace(pkg: HostedPackage, timeoutMs = 30_000): Promise<{ pending: boolean; active?: ActiveHostedPlugin; reconnectRequired?: boolean }> {
    return this.serialize(async () => {
      if (pkg.id !== this.broker.pluginId) throw new HostedPluginError("identity_mismatch", "Plugin package identity mismatch");
      if (!await this.hooks.canSwitch()) { this.pendingPackage = pkg; return { pending: true }; }
      await this.ownRuntime();
      let current: ActiveHostedPlugin | null;
      try {
        current = (await this.broker.recover()).active;
        if (current && current.schema !== pkg.manifest.dataSchemaVersion) throw new HostedPluginError("migration_required", "Cross-schema activation requires a verified state migration; old state preserved");
      } catch (error) { if (!this.worker) await this.releaseOwnership?.(); throw error; }
      const generation = current?.generation ?? 0, old = this.worker;
      if (!old) this.phaseValue = "starting";
      let candidate: HostedRuntimeProcess | null = null, committed = false, frozen = false;
      try {
        candidate = await HostedRuntimeProcess.start(pkg, generation + 1, this.workerEntry, this.callBroker);
        this.phaseValue = "draining";
        // Existing calls retain their old generation. New requests cannot start while draining.
        if (old && !await old.waitForIdle(timeoutMs)) throw new HostedPluginError("drain_pending", "Plugin calls are still running; switch deferred without killing them");
        frozen = true;
        await this.hooks.freeze();
        if (old && !await old.waitForIdle(timeoutMs)) throw new HostedPluginError("drain_pending", "Checkpoint synchronization is still running");
        if (!await this.hooks.canSwitch()) throw new HostedPluginError("editor_busy", "Editor became active during preparation; switch deferred");
        // Descriptor ownership/policy must be checked BEFORE the irreversible active-pointer commit.
        // A failure here retains the old worker/state; a committed-hook check alone is too late.
        await this.hooks.validateCandidate?.(structuredClone(candidate.tools));
        this.phaseValue = "switching";
        const stateRef = current ? await this.broker.forkState(generation) : randomUUID();
        const active = await this.broker.activate(generation, { version: pkg.version, stateRef, schema: pkg.manifest.dataSchemaVersion, enabled: true });
        committed = true; this.worker = candidate; candidate = null; this.phaseValue = "active"; this.pendingPackage = null;
        let reconnectRequired = false;
        // A disconnected browser isn't an atomic DB participant. Keep the committed generation,
        // reject old writes and ask it to reconnect; do not roll back accepted new-generation writes.
        try { await this.hooks.committed(active); } catch { reconnectRequired = true; }
        await old?.dispose();
        return { pending: false, active, ...(reconnectRequired ? { reconnectRequired: true } : {}) };
      } catch (error) {
        if (!committed) {
          this.phaseValue = old?.healthy ? "active" : old ? "failed" : "disabled";
          if (frozen) await this.hooks.resume().catch(() => {});
        }
        throw error;
      } finally {
        await candidate?.dispose();
        if (!this.worker) await this.releaseOwnership?.();
      }
    });
  }
  retryPending(timeoutMs?: number) {
    if (!this.pendingPackage) return Promise.resolve({ pending: false });
    return this.replace(this.pendingPackage, timeoutMs);
  }
  /** Reversible process handoff. The state pointer and generation do not change.
   * A failed host selection restores the same code/state before resuming exact views.
   */
  suspendForRestart(timeoutMs = 30_000): Promise<() => Promise<void>> {
    return this.serialize(async () => {
      const old = this.worker, previous = this.phaseValue;
      const active = await this.broker.active();
      const restoreWorker = async () => {
        if (!old || this.worker) return;
        await this.ownRuntime();
        if (JSON.stringify(await this.broker.active()) !== JSON.stringify(active)) {
          await this.releaseOwnership?.(); this.phaseValue = "failed";
          throw new HostedPluginError("restart_recovery_changed", "Plugin state changed during host handoff; retain data and reconnect to its current owner");
        }
        try {
          this.worker = await HostedRuntimeProcess.start(old.package, old.generation, this.workerEntry, this.callBroker);
          await this.hooks.validateCandidate?.(this.worker.tools);
        } catch (error) {
          await this.worker?.dispose(); this.worker = null; this.phaseValue = "failed";
          await this.releaseOwnership?.(); throw error;
        }
      };
      this.phaseValue = "draining";
      try {
        if (old && !await old.waitForIdle(timeoutMs)) throw new HostedPluginError("drain_pending", "Plugin work is still draining; current host retained");
        await this.hooks.freeze();
        if (old && !await old.waitForIdle(timeoutMs)) throw new HostedPluginError("drain_pending", "Checkpoint work is still draining; current host retained");
        await old?.dispose(); this.worker = null; this.phaseValue = "disabled";
        await this.releaseOwnership?.();
      } catch (error) {
        try {
          // Releasing custody can fail after the old process has stopped. That
          // partial suspension still owes the running host its worker back.
          await restoreWorker(); this.phaseValue = previous; await this.hooks.resume();
        } catch (restoreError) { this.phaseValue = "failed"; throw restoreError; }
        throw error;
      }
      let resumed = false;
      return () => this.serialize(async () => {
        if (resumed) return;
        await restoreWorker();
        this.phaseValue = previous;
        await this.hooks.resume(); resumed = true;
      });
    });
  }
  disable(timeoutMs = 30_000): Promise<void> {
    return this.serialize(async () => {
      await this.ownRuntime();
      const old = this.worker;
      let current: ActiveHostedPlugin | null;
      try { current = (await this.broker.recover()).active; }
      catch (error) { if (!old) await this.releaseOwnership?.(); throw error; }
      if (!current) {
        if (old) { this.phaseValue = "failed"; throw new HostedPluginError("storage_missing", "Active plugin storage is missing; refusing to report a successful disable"); }
        this.phaseValue = "disabled"; this.pendingPackage = null; await this.releaseOwnership?.(); return;
      }
      if (!old && !current.enabled) { this.phaseValue = "disabled"; this.pendingPackage = null; await this.releaseOwnership?.(); return; }
      const previous = this.phaseValue;
      this.phaseValue = "draining";
      let frozen = false;
      try {
        if (old && !await old.waitForIdle(timeoutMs)) throw new HostedPluginError("drain_pending", "Plugin still has in-flight work; not killed");
        frozen = true; await this.hooks.freeze();
        if (old && !await old.waitForIdle(timeoutMs)) throw new HostedPluginError("drain_pending", "Checkpoint synchronization is still running");
        const active = await this.broker.activate(current.generation, { version: current.version, stateRef: current.stateRef, schema: current.schema, enabled: false });
        this.worker = null; this.phaseValue = "disabled"; this.pendingPackage = null;
        await old?.dispose();
        await this.hooks.committed(active);
      } catch (error) {
        // If activation already committed, never claim the old generation is still writable.
        if (this.worker === old) { this.phaseValue = previous; if (frozen) await this.hooks.resume().catch(() => {}); }
        throw error;
      } finally { if (!this.worker) await this.releaseOwnership?.(); }
    });
  }
  /** Host shutdown keeps installed/enabled intent; only an explicit disable changes the persisted flag. */
  shutdown(timeoutMs = 30_000): Promise<void> {
    return this.serialize(async () => {
      const old = this.worker, previous = this.phaseValue;
      this.phaseValue = "draining";
      try {
        if (old && !await old.waitForIdle(timeoutMs)) throw new HostedPluginError("drain_pending", "Host shutdown still has plugin work to drain");
        await this.hooks.freeze();
        if (old && !await old.waitForIdle(timeoutMs)) throw new HostedPluginError("drain_pending", "Host checkpoint synchronization is still running");
        await old?.dispose();
        this.worker = null; this.phaseValue = "disabled";
        await this.releaseOwnership?.();
      } catch (error) { this.phaseValue = previous; await this.hooks.resume().catch(() => {}); throw error; }
    });
  }
}
