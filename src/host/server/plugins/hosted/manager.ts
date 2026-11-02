import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import type { HostedInvocation, HostedScope, HostedToolDescriptor } from "@chengzhiyi/pi-web-protocol";
import { CapabilityBroker, type CapabilityBrokerOptions } from "./capabilities/broker.ts";
import { parseDeclarations } from "./capabilities/declarations.ts";
import { PluginScheduler } from "./capabilities/scheduler.ts";
import { HostedPluginError, failure } from "./errors.ts";
import { HostedPluginInstaller } from "./installer.ts";
import { officialPlugin, type OfficialPlugin, type RegistryRelease, type UpdatePolicy } from "./official-catalog.ts";
import { HostedStateBroker } from "./state-broker.ts";
import { HostedPluginSupervisor, type HostedSwitchHooks } from "./supervisor.ts";
import { hostedAsset, type HostedPackage } from "./resources.ts";
import { atomicJson, boundedRead, readJson, withStorageLock } from "./storage.ts";
import { compareVersions } from "./versions.ts";
import { readFile } from "node:fs/promises";
import { candidateHost, fingerprint, inFlightPair, pairRoot, pairTransaction, readPair, writePair, type PairIntent, type PairSelection } from "../../updates/hosted-pair.ts";

interface Policy { updatePolicy: UpdatePolicy; pinnedVersion?: string }
export interface UpdateDiagnostic {
  hostVersion: string; checkedAt: string; status: "available" | "up-to-date" | "failed";
  version?: string; message: string; code?: string;
}
export interface HostedManagerOptions {
  root: string;
  hostVersion: string;
  /** Current application package root, supplied by production bootstrap for full startup identity. */
  packageRoot?: string;
  workerEntry: string;
  catalog?: readonly OfficialPlugin[];
  fetch?: typeof globalThis.fetch;
  hooks(id: string): HostedSwitchHooks;
  /** Enter the all-Agent settled barrier only for activation/disable, AFTER background preparation. */
  lifecycle?<T>(pluginId: string, operation: () => Promise<T>, shutdown?: boolean): Promise<T>;
  legacy?(id: string): (request: HostedInvocation) => Promise<unknown>;
  /** Enables network/sessions for plugins that declare them. Without it every capability call is denied. */
  capabilities?: CapabilityBrokerOptions;
  /** Host-authenticated scope for scheduled ticks; null skips the tick. The plugin never chooses it. */
  scheduledScope?(pluginId: string): HostedScope | null;
  onScheduleError?(pluginId: string, scheduleId: string, error: unknown): void;
  /** Test seam for timers. */
  /** Plugin id -> local .tgz (developer opt-in). Those plugins install/update from the file, never the registry. */
  devArchives?: ReadonlyMap<string, string>;
  /** Plugin id -> developer package directory (explicit opt-in). The map may be updated live; entries win over `devArchives`. */
  devRoots?: ReadonlyMap<string, string>;
  scheduleTimers?: { setInterval(fn: () => void, ms: number): unknown; clearInterval(handle: unknown): void };
}
export interface ManagedHostedPlugin {
  id: string; name: string; description: { zh: string; en: string }; official: true;
  installed: boolean; installedVersions: string[]; version: string | null; activeVersion: string | null;
  enabled: boolean; phase: string; generation: number | null; pendingVersion: string | null;
  updatePolicy: UpdatePolicy; pinnedVersion?: string; updateDiagnostic?: UpdateDiagnostic; availableVersion: string | null; error?: ReturnType<typeof failure>;
  digest?: string; document?: string; controller?: string; assetBase?: string;
}
/** Application-level service; authentication/scope resolution belongs to the host, never the plugin. */
export class HostedPluginManager {
  readonly installer: HostedPluginInstaller;
  private readonly options: HostedManagerOptions;
  private readonly supervisors = new Map<string, HostedPluginSupervisor>();
  private readonly packages = new Map<string, HostedPackage>();
  private readonly assetTokens = new Map<string, string>();
  private readonly operations = new Map<string, Promise<unknown>>();
  private readonly errors = new Map<string, ReturnType<typeof failure>>();
  private readonly available = new Map<string, RegistryRelease>();
  private readonly assetLeases = new Map<string, Map<string, number>>();
  private closing = false;
  private readonly scheduler: PluginScheduler;
  private pairAdmittedValue = false;
  get pairAdmitted(): boolean { return this.pairAdmittedValue; }
  constructor(options: HostedManagerOptions) {
    this.options = options;
    this.installer = new HostedPluginInstaller({ root: join(options.root, "packages"), hostVersion: options.hostVersion, catalog: options.catalog, fetch: options.fetch });
    const capabilities = options.capabilities ? new CapabilityBroker(options.capabilities) : undefined;
    this.scheduler = new PluginScheduler({
      invoke: async (pluginId, schedule) => {
        const scope = this.closing ? null : options.scheduledScope?.(pluginId) ?? null;
        if (!scope) return;
        await this.supervisor(pluginId).invoke({ requestId: randomUUID(), scope, kind: "action", action: schedule.action, input: { schedule: schedule.id } });
      },
      onError: (pluginId, schedule, error) => options.onScheduleError?.(pluginId, schedule.id, error),
      ...options.scheduleTimers,
    });
    for (const plugin of this.installer.catalog) {
      const broker = new HostedStateBroker(join(options.root, "data"), plugin.id, options.legacy?.(plugin.id));
      const hooks = options.hooks(plugin.id);
      this.supervisors.set(plugin.id, new HostedPluginSupervisor(broker, options.workerEntry, {
        validateCandidate: tools => hooks.validateCandidate?.(tools),
        canSwitch: () => hooks.canSwitch(),
        freeze: () => hooks.freeze(),
        resume: () => hooks.resume(),
        committed: async active => {
          if (active.enabled) {
            const pkg = await this.installer.load(plugin.id, active.version);
            this.packages.set(plugin.id, pkg);
            this.assetTokens.set(plugin.id, randomBytes(24).toString("base64url"));
            try { this.scheduler.start(plugin.id, parseDeclarations(pkg.manifest).schedules); }
            catch (error) { this.scheduler.stop(plugin.id); this.errors.set(plugin.id, failure(error)); }
          } else { this.scheduler.stop(plugin.id); this.packages.delete(plugin.id); this.assetTokens.delete(plugin.id); }
          await hooks.committed(active);
        },
      }, capabilities));
    }
  }
  /** Developer-supplied source (directory or tgz) for this plugin, or null for the registry. */
  private devSource(id: string): ((signal?: AbortSignal) => Promise<HostedPackage>) | null {
    const root = this.options.devRoots?.get(id), archive = this.options.devArchives?.get(id);
    if (root) return signal => this.installer.installDevDirectory(id, root, signal);
    if (archive) return signal => this.installer.installDevArchive(id, archive, signal);
    return null;
  }
  isDevPlugin(id: string): boolean { return !!(this.options.devRoots?.has(id) || this.options.devArchives?.has(id)); }
  private supervisor(id: string) {
    officialPlugin(id, this.installer.catalog);
    const supervisor = this.supervisors.get(id);
    if (!supervisor) throw new HostedPluginError("unknown_plugin", "Plugin runtime is not registered");
    return supervisor;
  }
  /** Plugin operations queue per plugin and use only that plugin's own storage locks.
   * Host-update state (the pair journal) never fences installing, enabling, disabling or removing a plugin. */
  private serialize<T>(id: string, run: () => Promise<T>): Promise<T> {
    this.supervisor(id);
    if (this.closing) return Promise.reject(new HostedPluginError("manager_closed", "Plugin manager is shutting down"));
    const result = (this.operations.get(id) ?? Promise.resolve()).then(run, run);
    this.operations.set(id, result);
    void result.then(() => this.errors.delete(id), error => { this.errors.set(id, failure(error)); }).finally(() => { if (this.operations.get(id) === result) this.operations.delete(id); });
    return result;
  }
  private lifecycle<T>(id: string, operation: () => Promise<T>, shutdown = false): Promise<T> {
    return this.options.lifecycle ? this.options.lifecycle(id, operation, shutdown) : operation();
  }
  private async policies(): Promise<Record<string, Policy>> {
    const value = await readJson<Record<string, Policy>>(join(this.options.root, "policies", "policies.json"));
    if (!value) {
      if (await boundedRead(join(this.options.root, "policies", "policies.json"), 2 * 1024 * 1024)) throw new HostedPluginError("invalid_storage", "Null plugin policies; restore pin/disable choices before cleanup");
      return {};
    }
    for (const [id, p] of Object.entries(value)) {
      if (!this.installer.catalog.some(known => known.id === id)) continue; // Retained for the host that owns it.
      if (!p || !["notify", "automatic", "pinned"].includes(p.updatePolicy) || p.updatePolicy === "pinned" && !p.pinnedVersion || p.pinnedVersion && !/^\d+\.\d+\.\d+$/.test(p.pinnedVersion)) throw new HostedPluginError("invalid_storage", "Invalid plugin update policy");
    }
    // Legacy choices no longer constrain software-linked or manual updates.
    // Normalize before pair fingerprints too, so old pins cannot fence a prepared pair.
    return Object.fromEntries(Object.keys(value).map(id => [id, { updatePolicy: "notify" as const }]));
  }
  private async diagnostics(): Promise<Record<string, UpdateDiagnostic>> {
    return await readJson<Record<string, UpdateDiagnostic>>(join(this.options.root, "policies", "update-checks.json")) ?? {};
  }
  private async recordCheck(id: string, detail: Omit<UpdateDiagnostic, "hostVersion" | "checkedAt">): Promise<void> {
    await withStorageLock(join(this.options.root, "policies"), async () => {
      const diagnostics = await this.diagnostics();
      diagnostics[id] = { ...detail, hostVersion: this.options.hostVersion, checkedAt: new Date().toISOString() };
      await atomicJson(join(this.options.root, "policies", "update-checks.json"), diagnostics);
    });
  }
  private recordDevSync(id: string, version: string) {
    return this.recordCheck(id, { status: "up-to-date", version, message: "Developer source installed" });
  }
  private async check(id: string, current?: string, exact?: string, signal?: AbortSignal): Promise<RegistryRelease> {
    try {
      const release = await this.installer.check(id, current, exact, signal);
      const newer = !current || compareVersions(release.version, current) > 0;
      if (newer) this.available.set(id, release); else this.available.delete(id);
      await this.recordCheck(id, { status: newer ? "available" : "up-to-date", version: release.version,
        message: newer ? "Compatible stable release available" : "No newer compatible stable release; installed code preserved" });
      return release;
    } catch (error) {
      this.available.delete(id);
      await this.recordCheck(id, { status: "failed", code: failure(error).code, message: failure(error).message });
      throw error;
    }
  }
  async setPolicy(id: string, policy: Policy): Promise<void> {
    this.supervisor(id);
    if (!["notify", "automatic", "pinned"].includes(policy.updatePolicy) || policy.updatePolicy === "pinned" && !policy.pinnedVersion || policy.pinnedVersion && !/^\d+\.\d+\.\d+$/.test(policy.pinnedVersion)) throw new HostedPluginError("invalid_input", "Invalid plugin update policy");
    await withStorageLock(join(this.options.root, "policies"), async () => {
      const policies = await this.policies(); policies[id] = { updatePolicy: "notify" }; // Compatibility endpoint; legacy strategies are retired.
      await atomicJson(join(this.options.root, "policies", "policies.json"), policies);
    });
  }
  /** Settles the host-update journal under its own lock before any plugin loads. Running is the
   * host's health outcome; no plugin result is ever written to it. Settled records are rewritten in
   * the schema-1 encoding so an older fallback host never reads them as in flight. */
  private settleHostPair(): Promise<{ intent: PairIntent | null; admitted: boolean }> {
    return withStorageLock(pairRoot(this.options.root), async () => {
      const intent = await readPair(this.options.root);
      if (!intent) return { intent, admitted: false };
      if (!inFlightPair(intent)) {
        if (intent.phase === "required-action") await writePair(this.options.root, intent);
        return { intent, admitted: false };
      }
      try {
        if (intent.version !== this.options.hostVersion || intent.hostDigest !== await candidateHost(intent.version, intent.packageRoot) ||
            this.options.packageRoot && intent.hostDigest !== await candidateHost(this.options.hostVersion, this.options.packageRoot) ||
            !Buffer.from(await readFile(this.options.workerEntry)).equals(await readFile(join(intent.packageRoot, "dist", "hosted-worker.js")))) throw new Error("Running host differs from selected pair");
      } catch (error) {
        // The selected host is not the one running (e.g. the launcher fell back). The attempt is
        // over: plugins keep running on this host and the next update starts fresh.
        await writePair(this.options.root, { ...intent, phase: "cancelled", message: `Selected host not running; current host and plugins retained. ${failure(error).message}; data retained` });
        return { intent, admitted: false };
      }
      await writePair(this.options.root, { ...intent, phase: "reconciled", message: "Selected host running; plugins load independently and report their own errors" });
      return { intent, admitted: true };
    });
  }
  /** Offline startup: catalog absence never downloads editor code; failures remain visible. */
  async start(): Promise<void> {
    await withStorageLock(join(this.options.root, "policies"), async () => {
      const policies = await this.policies();
      await atomicJson(join(this.options.root, "policies", "policies.json"), policies);
    });
    const { intent, admitted: recovering } = await this.settleHostPair();
    // A staged plugin that changed is a plugin problem, not a host one: load each plugin's
    // current version instead of the staged selection.
    let useSelections = recovering;
    if (recovering && intent) try { await this.validatePairPackages(intent.version, intent.selections); } catch { useSelections = false; }
    await this.installer.inventory();
    const startupFingerprint = fingerprint(await this.pairSnapshot());
    for (const plugin of this.installer.catalog) {
      const s = this.supervisor(plugin.id), active = await s.broker.active();
      if (!active?.enabled) continue;
      try {
        const selected = recovering && useSelections ? intent?.selections.find(p => p.id === plugin.id) : undefined;
        // Never replay an old plan over a newer accepted generation/pin/disable. A crash after
        // activation simply loads the now-current compatible version on the next startup.
        const unchanged = selected && fingerprint(active) === fingerprint(selected.before) &&
          intent?.fingerprint === startupFingerprint;
        const pkg = await this.installer.load(plugin.id, unchanged ? selected.version : active.version);
        if (unchanged && pkg.digest !== selected.digest) throw new Error("Staged plugin digest changed");
        await this.lifecycle(plugin.id, () => s.replace(pkg)); this.packages.set(plugin.id, pkg);
        if (!recovering) await this.collectSettled(plugin.id);
      } catch (error) {
        const detail = failure(error);
        const recovery = ["runtime_owned", "storage_busy"].includes(detail.code)
          ? "Stop all owners, verify a backup and use the offline hosted-recovery tool."
          : "Update, reinstall or disable this plugin; the rest of the app is unaffected.";
        this.errors.set(plugin.id, { ...detail, message: `Plugin unavailable: startup failed (${detail.code}): ${detail.message}; data retained. ${recovery}` });
      }
    }
    // A plugin that fails to start (selected or not) only becomes unusable: its error stays on its
    // own card and the next startup / plugin update retries it.
    this.pairAdmittedValue = recovering && !this.errors.size;
  }
  async inventory(): Promise<{ plugins: ManagedHostedPlugin[]; errors: string[] }> {
    const installed = await this.installer.inventory(), policies = await this.policies(), diagnostics = await this.diagnostics();
    const plugins = await Promise.all(this.installer.catalog.map(async plugin => {
      const s = this.supervisor(plugin.id), active = await s.broker.active(), pkg = this.packages.get(plugin.id);
      const versions = (installed.versions[plugin.id] ?? []).map(v => v.version).sort((a, b) => compareVersions(b, a));
      return {
        id: plugin.id, name: plugin.name, description: plugin.description, official: true as const,
        installed: !!versions.length, installedVersions: versions, version: versions[0] ?? null,
        activeVersion: active?.version ?? null, enabled: active?.enabled ?? false,
        phase: s.phase, generation: s.generation, pendingVersion: s.pendingVersion,
        updatePolicy: policies[plugin.id]?.updatePolicy ?? "notify", pinnedVersion: policies[plugin.id]?.pinnedVersion,
        updateDiagnostic: diagnostics[plugin.id], availableVersion: this.available.get(plugin.id)?.version ?? (diagnostics[plugin.id]?.status === "available" ? diagnostics[plugin.id]!.version ?? null : null),
        ...(this.errors.has(plugin.id) ? { error: this.errors.get(plugin.id)! } : {}),
        ...(pkg && s.phase === "active" ? { digest: pkg.digest, document: pkg.manifest.frontend.document.slice(2), controller: pkg.manifest.frontend.controller.slice(2), assetBase: `/hosted-plugins/${encodeURIComponent(plugin.id)}/${this.assetTokens.get(plugin.id)}/${pkg.digest}/` } : {}),
      };
    }));
    return { plugins, errors: [] };
  }
  get tools(): Array<{ pluginId: string; generation: number; descriptors: HostedToolDescriptor[] }> {
    return [...this.supervisors].flatMap(([pluginId, s]) => s.phase === "active" && s.generation !== null ? [{ pluginId, generation: s.generation, descriptors: s.tools }] : []);
  }
  async manage(id: string, operation: "install" | "enable" | "disable" | "update" | "uninstall" | "check" | "retry", version?: string, signal?: AbortSignal): Promise<unknown> {
    return this.serialize(id, async () => {
      const s = this.supervisor(id), installed = (await this.installer.inventory()).versions[id] ?? [];
      const latest = installed.map(v => v.version).sort((a, b) => compareVersions(b, a))[0];
      const result = await (async () => { switch (operation) {
        case "check": {
          if (this.isDevPlugin(id)) return { version: latest ?? null, dev: true };
          const release = await this.check(id, latest, undefined, signal); return { version: release.version };
        }
        case "install": {
          const dev = this.devSource(id);
          if (dev) { const pkg = await dev(signal); await this.recordDevSync(id, pkg.version); return { installed: true, version: pkg.version }; }
          const release = await this.check(id, latest, version, signal);
          const pkg = await this.installer.install(id, release, signal); this.available.delete(id);
          await this.recordCheck(id, { status: "up-to-date", version: pkg.version, message: "Selected compatible release installed; enablement unchanged" });
          // Installation and activation are separate: downloaded code is not silently enabled.
          return { installed: true, version: pkg.version };
        }
        case "enable": {
          const selected = version ?? latest;
          if (!selected) throw new HostedPluginError("not_installed", "Install the plugin first");
          const pkg = await this.installer.load(id, selected), result = await this.lifecycle(id, () => s.replace(pkg));
          if (!result.pending) this.packages.set(id, pkg);
          return result;
        }
        case "retry": {
          const pending = s.pendingVersion;
          const result = await this.lifecycle(id, () => s.retryPending());
          if (pending && !result.pending) this.packages.set(id, await this.installer.load(id, pending));
          return result;
        }
        case "disable": await this.lifecycle(id, () => s.disable()); this.packages.delete(id); return { enabled: false };
        case "update": {
          if (!latest) throw new HostedPluginError("not_installed", "Only installed plugins can be updated");
          const dev = this.devSource(id);
          if (dev) {
            const pkg = await dev(signal), active = await s.broker.active();
            // A stale failed diagnostic from an earlier attempt must not outlive a later successful sync.
            await this.recordDevSync(id, pkg.version);
            if (!active?.enabled) return { installed: true, enabled: false, version: pkg.version };
            if (active.version === pkg.version && !s.pendingVersion) return { unchanged: true, version: pkg.version };
            const result = await this.lifecycle(id, () => s.replace(pkg)); if (!result.pending) this.packages.set(id, pkg); return result;
          }
          const release = await this.check(id, latest, version, signal);
          const active = await s.broker.active();
          if (release.version === latest && (!active?.enabled || active.version === latest) && !s.pendingVersion) return { unchanged: true, version: latest };
          const pkg = release.version === latest ? await this.installer.load(id, latest) : await this.installer.install(id, release, signal);
          this.available.delete(id);
          await this.recordCheck(id, { status: "up-to-date", version: pkg.version, message: "Selected compatible release installed; activation may wait for editors" });
          if (!active?.enabled) return { installed: true, enabled: false, version: pkg.version };
          const result = await this.lifecycle(id, () => s.replace(pkg)); if (!result.pending) this.packages.set(id, pkg); return result;
        }
        case "uninstall": {
          await this.lifecycle(id, () => s.disable()); this.packages.delete(id);
          await this.installer.removeVersions(id, installed.map(v => v.version)); this.available.delete(id);
          return { installed: false, dataPreserved: true };
        }
        default: throw new HostedPluginError("invalid_operation", "Unknown plugin management operation");
      } })().catch(async error => {
        if (["install", "update"].includes(operation)) {
          this.available.delete(id);
          const detail = failure(error);
          await this.recordCheck(id, { status: "failed", code: detail.code, message: detail.message });
        }
        throw error;
      });
      if (["install", "enable", "retry", "update"].includes(operation)) await this.collectSettled(id);
      return result;
    });
  }
  /** Explicit offline maintenance uses the same manager fence as lifecycle operations. */
  collect(id: string): Promise<string[]> { return this.serialize(id, () => this.collectSettled(id)); }
  private async collectSettled(id: string): Promise<string[]> {
    const s = this.supervisor(id);
    return s.broker.collect(async references => this.installer.collect(id, async () => {
      const policy = (await this.policies())[id];
      return [...references.map(v => v.version), ...(s.pendingVersion ? [s.pendingVersion] : []),
        ...(this.packages.has(id) ? [this.packages.get(id)!.version] : []),
        ...(policy?.pinnedVersion ? [policy.pinnedVersion] : []), ...(this.assetLeases.get(id)?.keys() ?? [])];
    }));
  }
  /** Scope is filled from retained authenticated host sessions; caller generation is mandatory. */
  invoke(id: string, generation: number, request: Omit<HostedInvocation, "generation">): Promise<unknown> {
    const s = this.supervisor(id);
    if (generation !== s.generation) return Promise.reject(new HostedPluginError("stale_generation", "Reconnect the plugin view before editing", { status: 409 }));
    return s.invoke(request);
  }
  /** Flush-only host endpoint for a registered switch barrier, NEVER normal browser admission. */
  flush(id: string, generation: number, request: Omit<HostedInvocation, "generation" | "kind">): Promise<unknown> {
    const s = this.supervisor(id);
    if (generation !== s.generation) return Promise.reject(new HostedPluginError("stale_generation", "Flush generation changed", { status: 409 }));
    return s.flushAction(request);
  }
  async asset(id: string, digest: string, path: string) {
    const pkg = this.packages.get(id);
    if (!pkg) return null;
    let leases = this.assetLeases.get(id);
    if (!leases) { leases = new Map(); this.assetLeases.set(id, leases); }
    leases.set(pkg.version, (leases.get(pkg.version) ?? 0) + 1);
    try { return await hostedAsset(pkg, path, digest); }
    finally {
      const count = leases.get(pkg.version)! - 1;
      if (count) leases.set(pkg.version, count); else leases.delete(pkg.version);
    }
  }
  /** Capability-qualified URL is required because subresource requests cannot attach a bearer header.
   * No user/session data is served here. Capability rotates on every committed generation.
   */
  async assetRequest(path: string) {
    const match = /^\/hosted-plugins\/([^/]+)\/([A-Za-z0-9_-]{32})\/([a-f0-9]{64})\/(.+)$/.exec(path);
    if (!match) return null;
    let id: string; try { id = decodeURIComponent(match[1]!); } catch { return null; }
    const token = this.assetTokens.get(id), candidate = Buffer.from(match[2]!);
    if (!token || candidate.length !== Buffer.byteLength(token) || !timingSafeEqual(candidate, Buffer.from(token))) return null;
    return this.asset(id, match[3]!, match[4]!);
  }
  /** Host-upgrade/startup reconciliation: only installed items; preserve disabled choices.
   * Registry failure never discards compatible local code. Incompatibility remains a visible error.
   */
  async reconcileHostUpgrade(): Promise<boolean> {
    // A pending pair owns selection. Do not overwrite its actual startup failure
    // (e.g. runtime_owned) with the generic management fence or touch the registry.
    if (inFlightPair(await readPair(this.options.root))) return false;
    const inventory = await this.installer.inventory(), policies = await this.policies();
    let succeeded = true;
    for (const plugin of this.installer.catalog) {
      const versions = inventory.versions[plugin.id]; if (!versions?.length) continue;
      try {
        const active = await this.supervisor(plugin.id).broker.active();
        const current = active?.enabled ? active.version : versions.map(v => v.version).sort((a, b) => compareVersions(b, a))[0]!;
        try { await this.installer.load(plugin.id, current); continue; }
        catch (error) { if (failure(error).code !== "incompatible_plugin") throw error; }
        // Only a real protocol/range conflict requires host-linked coordination.
        // Compatible plugin updates remain an independent explicit operation.
        const result = await this.manage(plugin.id, "update");
        if (result && typeof result === "object" && "pending" in result && result.pending) succeeded = false;
      }
      catch (error) {
        succeeded = false;
        const detail = failure(error);
        this.errors.set(plugin.id, detail);
        await this.recordCheck(plugin.id, { status: "failed", code: detail.code, message: detail.message });
      }
    }
    return succeeded;
  }
  async pairSnapshot(): Promise<unknown> {
    return { policies: await this.policies(), active: await Promise.all(this.installer.catalog.map(async p => [p.id, await this.supervisor(p.id).broker.active()])) };
  }
  get hostPair() { return pairTransaction(this.options.root, (version, signal) => this.prepareHostPair(version, signal), () => this.pairSnapshot(), (version, selections) => this.validatePairPackages(version, selections)); }
  private async validatePairPackages(hostVersion: string, selections: PairSelection[]): Promise<void> {
    const target = new HostedPluginInstaller({ root: this.installer.root, hostVersion, catalog: this.installer.catalog });
    for (const selection of selections) {
      const pkg = await target.load(selection.id, selection.version);
      if (pkg.digest !== selection.digest) throw new HostedPluginError("host_pair_changed", "Staged plugin digest changed; selection refused");
    }
  }
  private async prepareHostPair(hostVersion: string, signal?: AbortSignal): Promise<PairSelection[]> {
    const target = new HostedPluginInstaller({ root: this.installer.root, hostVersion, catalog: this.installer.catalog, fetch: this.options.fetch });
    const inventory = await this.installer.inventory(), policies = await this.policies();
    const selections: PairSelection[] = [];
    for (const plugin of this.installer.catalog) {
      const versions = inventory.versions[plugin.id]; if (!versions?.length) continue;
      const active = await this.supervisor(plugin.id).broker.active();
      const latest = versions.map(v => v.version).sort((a, b) => compareVersions(b, a))[0]!;
      // Compatible plugins evolve independently. A host update is not an implicit
      // plugin update: retain the exact live version and its data schema offline.
      // A plugin never blocks the host update: when no usable version exists for the new host it
      // is left out of the selection and simply starts unavailable (data retained, error on its card).
      let pkg: HostedPackage | null = null;
      try { pkg = await target.load(plugin.id, active?.enabled ? active.version : latest); }
      catch (error) {
        const detail = failure(error);
        if (detail.code === "incompatible_plugin") try {
          const release = await target.check(plugin.id, latest, undefined, signal);
          pkg = release.version === latest ? await target.load(plugin.id, latest) : await target.install(plugin.id, release, signal);
          await this.recordCheck(plugin.id, { status: "up-to-date", version: pkg.version, message: "Compatible combination prepared for software update" });
          this.errors.delete(plugin.id);
        } catch (updateError) {
          signal?.throwIfAborted();
          const cause = failure(updateError);
          // Older local code may still fit the new host.
          if (latest !== active?.version) pkg = await target.load(plugin.id, latest).catch(() => null);
          if (!pkg) await this.recordCheck(plugin.id, { status: "failed", code: cause.code, message: `${cause.message}; plugin will be unavailable after the software update until a compatible release is installed` });
        } else await this.recordCheck(plugin.id, { status: "failed", code: detail.code, message: `${detail.message}; plugin will be unavailable after the software update` });
      }
      if (!pkg) continue;
      selections.push({ id: plugin.id, version: pkg.version, digest: pkg.digest, before: active });
    }
    return selections;
  }
  /** Per-plugin compatibility against a future host's declared protocol range: a warning list,
   * never a gate. No registry/install/activation happens here; a plugin with no usable local
   * version simply starts unavailable on the new host until a compatible release is installed. */
  async hostUpdateWarnings(hostVersion: string): Promise<Array<{ pluginId: string; message: string }>> {
    const target = new HostedPluginInstaller({ root: this.installer.root, hostVersion, catalog: this.installer.catalog });
    const inventory = await this.installer.inventory(), warnings: Array<{ pluginId: string; message: string }> = [];
    for (const plugin of this.installer.catalog) {
      const versions = inventory.versions[plugin.id], active = await this.supervisor(plugin.id).broker.active();
      if (!active?.enabled) continue;
      if (!versions?.length) { warnings.push({ pluginId: plugin.id, message: "Plugin is not installed; it stays unavailable after the update until it is reinstalled" }); continue; }
      const candidates = [active.version, ...versions.map(v => v.version).sort((a, b) => compareVersions(b, a))];
      let usable = false, cause = "";
      for (const version of new Set(candidates)) {
        try { await target.load(plugin.id, version); usable = true; break; }
        catch (error) { cause ||= failure(error).message; }
      }
      if (!usable) warnings.push({ pluginId: plugin.id, message: `No installed version supports ${hostVersion} (${cause}); it is unavailable after the update until a compatible release is installed` });
    }
    return warnings;
  }
  async shutdown(): Promise<void> {
    this.closing = true;
    await Promise.allSettled(this.operations.values());
    try {
      await Promise.all([...this.supervisors].map(([id, s]) => this.lifecycle(id, () => s.shutdown(), true)));
      this.scheduler.stopAll();
      this.packages.clear(); this.assetTokens.clear();
    } catch (error) { this.closing = false; throw error; }
  }
  /** A restart lease owns only live workers, never active pointers or asset identities.
   * Partial failure unwinds already suspended plugins so base hosting remains usable.
   */
  async suspendForRestart(force = false): Promise<() => Promise<void>> {
    this.closing = true;
    await Promise.allSettled(this.operations.values());
    const resumes: Array<() => Promise<void>> = [];
    const resume = async () => {
      const results = await Promise.allSettled(resumes.map(restore => restore()));
      this.closing = false;
      const failed = results.find(result => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    };
    try {
      for (const supervisor of this.supervisors.values()) resumes.push(await supervisor.suspendForRestart(undefined, force));
      return resume;
    } catch (error) { await resume(); throw error; }
  }
}
