import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import type { HostedInvocation, HostedToolDescriptor } from "@chengzhiyi/pi-web-protocol";
import { HostedPluginError, failure } from "./errors.ts";
import { HostedPluginInstaller } from "./installer.ts";
import { officialPlugin, type OfficialPlugin, type RegistryRelease, type UpdatePolicy } from "./official-catalog.ts";
import { HostedStateBroker } from "./state-broker.ts";
import { HostedPluginSupervisor, type HostedSwitchHooks } from "./supervisor.ts";
import { hostedAsset, type HostedPackage } from "./resources.ts";
import { atomicJson, boundedRead, readJson, withStorageLock } from "./storage.ts";
import { compareVersions } from "./versions.ts";
import { readFile } from "node:fs/promises";
import { assertPairIdle, candidateHost, fingerprint, pairRoot, pairTransaction, pendingPair, readPair, type PairSelection } from "../../updates/hosted-pair.ts";

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
  private pairAdmittedValue = false;
  get pairAdmitted(): boolean { return this.pairAdmittedValue; }
  constructor(options: HostedManagerOptions) {
    this.options = options;
    this.installer = new HostedPluginInstaller({ root: join(options.root, "packages"), hostVersion: options.hostVersion, catalog: options.catalog, fetch: options.fetch });
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
            this.packages.set(plugin.id, await this.installer.load(plugin.id, active.version));
            this.assetTokens.set(plugin.id, randomBytes(24).toString("base64url"));
          } else { this.packages.delete(plugin.id); this.assetTokens.delete(plugin.id); }
          await hooks.committed(active);
        },
      }));
    }
  }
  private supervisor(id: string) {
    officialPlugin(id, this.installer.catalog);
    const supervisor = this.supervisors.get(id);
    if (!supervisor) throw new HostedPluginError("unknown_plugin", "Plugin runtime is not registered");
    return supervisor;
  }
  private serialize<T>(id: string, run: () => Promise<T>): Promise<T> {
    this.supervisor(id);
    if (this.closing) return Promise.reject(new HostedPluginError("manager_closed", "Plugin manager is shutting down"));
    const fenced = () => withStorageLock(pairRoot(this.options.root), async () => { await assertPairIdle(this.options.root); return run(); });
    const result = (this.operations.get(id) ?? Promise.resolve()).then(fenced, fenced);
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
      officialPlugin(id, this.installer.catalog);
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
    await withStorageLock(pairRoot(this.options.root), async () => {
      await assertPairIdle(this.options.root);
      await withStorageLock(join(this.options.root, "policies"), async () => {
        const policies = await this.policies(); policies[id] = { updatePolicy: "notify" }; // Compatibility endpoint; legacy strategies are retired.
        await atomicJson(join(this.options.root, "policies", "policies.json"), policies);
      });
    });
  }
  /** Offline startup: catalog absence never downloads editor code; failures remain visible. */
  async start(): Promise<void> {
    await withStorageLock(pairRoot(this.options.root), () => this.startLocked());
  }
  private async startLocked(): Promise<void> {
    await withStorageLock(join(this.options.root, "policies"), async () => {
      const policies = await this.policies();
      await atomicJson(join(this.options.root, "policies", "policies.json"), policies);
    });
    const intent = await readPair(this.options.root);
    let recovering = pendingPair(intent);
    if (recovering && intent) {
      try {
        await this.validatePairPackages(intent.version, intent.selections);
        if (intent.version !== this.options.hostVersion || intent.hostDigest !== await candidateHost(intent.version, intent.packageRoot) ||
            this.options.packageRoot && intent.hostDigest !== await candidateHost(this.options.hostVersion, this.options.packageRoot) ||
            !Buffer.from(await readFile(this.options.workerEntry)).equals(await readFile(join(intent.packageRoot, "dist", "hosted-worker.js")))) throw new Error("Running host differs from selected pair");
      } catch (error) {
        const message = `Required action: restart the selected compatible host or inspect host-pair/intent.json with all owners stopped. ${failure(error).message}; data retained`;
        for (const plugin of this.installer.catalog) this.errors.set(plugin.id, failure(new HostedPluginError("host_pair_required", message)));
        await atomicJson(join(pairRoot(this.options.root), "intent.json"), { ...intent, phase: "required-action", message });
        // A failed/pre-pointer attempt must not make the still-compatible old host unusable.
        // Load ONLY its current state below, never the future selection on this runtime.
        recovering = false;
      }
    }
    await this.installer.inventory();
    const startupFingerprint = fingerprint(await this.pairSnapshot());
    for (const plugin of this.installer.catalog) {
      const s = this.supervisor(plugin.id), active = await s.broker.active();
      if (!active?.enabled) continue;
      try {
        const selected = recovering ? intent?.selections.find(p => p.id === plugin.id) : undefined;
        // Never replay an old plan over a newer accepted generation/pin/disable. A crash after
        // activation simply loads the now-current compatible version on the next startup.
        const unchanged = selected && fingerprint(active) === fingerprint(selected.before) &&
          intent?.fingerprint === startupFingerprint;
        const pkg = await this.installer.load(plugin.id, unchanged ? selected.version : active.version);
        if (unchanged && pkg.digest !== selected.digest) throw new Error("Staged plugin digest changed");
        await this.lifecycle(plugin.id, () => s.replace(pkg)); this.packages.set(plugin.id, pkg);
        if (!pendingPair(intent)) await this.collectSettled(plugin.id);
      } catch (error) { this.errors.set(plugin.id, failure(new HostedPluginError("host_pair_required", `Required action: choose a compatible host/plugin; data retained. ${failure(error).message}`))); }
    }
    if (recovering && intent) {
      await atomicJson(join(pairRoot(this.options.root), "intent.json"), { ...intent,
        phase: this.errors.size ? "required-action" : "reconciled", message: this.errors.size ? "Startup could not admit selected combination; preserve data and inspect plugin diagnostics" : "Current compatible state admitted; no previous state restored" });
      this.pairAdmittedValue = !this.errors.size;
    }
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
          const release = await this.check(id, latest, undefined, signal); return { version: release.version };
        }
        case "install": {
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
    const inventory = await this.installer.inventory(), policies = await this.policies();
    let succeeded = true;
    for (const plugin of this.installer.catalog) {
      const versions = inventory.versions[plugin.id]; if (!versions?.length) continue;
      try {
        // Every installed official plugin follows software updates, including legacy pins.
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
  get hostPair() { return pairTransaction(this.options.root, version => this.prepareHostPair(version), () => this.pairSnapshot(), (version, selections) => this.validatePairPackages(version, selections)); }
  private async validatePairPackages(hostVersion: string, selections: PairSelection[]): Promise<void> {
    const target = new HostedPluginInstaller({ root: this.installer.root, hostVersion, catalog: this.installer.catalog });
    for (const selection of selections) {
      const pkg = await target.load(selection.id, selection.version);
      if (pkg.digest !== selection.digest) throw new HostedPluginError("host_pair_changed", "Staged plugin digest changed; selection refused");
    }
  }
  private async prepareHostPair(hostVersion: string): Promise<PairSelection[]> {
    const target = new HostedPluginInstaller({ root: this.installer.root, hostVersion, catalog: this.installer.catalog, fetch: this.options.fetch });
    const inventory = await this.installer.inventory(), policies = await this.policies();
    const selections: PairSelection[] = [];
    for (const plugin of this.installer.catalog) {
      const versions = inventory.versions[plugin.id]; if (!versions?.length) continue;
      const active = await this.supervisor(plugin.id).broker.active();
      if (this.supervisor(plugin.id).pendingVersion) throw new HostedPluginError("host_pair_required", "Settle pending plugin activation before host update");
      const latest = versions.map(v => v.version).sort((a, b) => compareVersions(b, a))[0]!;
      let pkg: HostedPackage;
      try {
        const release = await target.check(plugin.id, latest);
        pkg = release.version === latest ? await target.load(plugin.id, latest) : await target.install(plugin.id, release);
        await this.recordCheck(plugin.id, { status: "up-to-date", version: pkg.version, message: "Compatible combination prepared for software update" });
        this.errors.delete(plugin.id);
      } catch (error) {
        // A failed update may retain compatible local code, never hide the failure or
        // accept an incompatible combination. The next software startup retries.
        const detail = failure(error);
        await this.recordCheck(plugin.id, { status: "failed", code: detail.code, message: detail.message });
        this.errors.set(plugin.id, detail);
        try { pkg = await target.load(plugin.id, latest); }
        catch (localError) { throw new HostedPluginError("host_pair_required", `${detail.message}; ${failure(localError).message}; current host/plugin and data retained`); }
      }
      selections.push({ id: plugin.id, version: pkg.version, digest: pkg.digest, before: active });
    }
    return selections;
  }
  /** Conservative pre-selection gate: no registry/install/activation against a future host.
   * A pair needing migration must be prepared by a full paired updater, not guessed here.
   */
  async validateHostUpdate(hostVersion: string): Promise<boolean> {
    const target = new HostedPluginInstaller({ root: this.installer.root, hostVersion, catalog: this.installer.catalog });
    const inventory = await this.installer.inventory(), policies = await this.policies();
    let installed = false;
    for (const plugin of this.installer.catalog) {
      const versions = inventory.versions[plugin.id];
      if (!versions?.length) continue;
      installed = true;
      const active = await this.supervisor(plugin.id).broker.active();
      const latest = versions.map(v => v.version).sort((a, b) => compareVersions(b, a))[0]!;
      const selected = new Set([latest, ...(active ? [active.version] : []), ...(policies[plugin.id]?.pinnedVersion ? [policies[plugin.id]!.pinnedVersion!] : []),
        ...(this.supervisor(plugin.id).pendingVersion ? [this.supervisor(plugin.id).pendingVersion!] : [])]);
      for (const version of selected) {
        try { await target.load(plugin.id, version); }
        catch (error) { throw new HostedPluginError("host_pair_required", `Host update blocked for ${plugin.id}@${version}: ${failure(error).message}. Prepare a compatible pair; installed code/data retained`); }
      }
    }
    return installed;
  }
  async shutdown(): Promise<void> {
    this.closing = true;
    await Promise.allSettled(this.operations.values());
    await Promise.all([...this.supervisors].map(([id, s]) => this.lifecycle(id, () => s.shutdown(), true)));
    this.packages.clear(); this.assetTokens.clear();
  }
}
