import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import type { HostedInvocation, HostedToolDescriptor } from "@chengzhiyi/pi-web-protocol";
import { HostedPluginError, failure } from "./errors.ts";
import { HostedPluginInstaller } from "./installer.ts";
import { officialPlugin, type OfficialPlugin, type RegistryRelease, type UpdatePolicy } from "./official-catalog.ts";
import { HostedStateBroker } from "./state-broker.ts";
import { HostedPluginSupervisor, type HostedSwitchHooks } from "./supervisor.ts";
import { hostedAsset, type HostedPackage } from "./resources.ts";
import { atomicJson, readJson, withStorageLock } from "./storage.ts";
import { compareVersions } from "./versions.ts";

interface Policy { updatePolicy: UpdatePolicy; pinnedVersion?: string }
export interface HostedManagerOptions {
  root: string;
  hostVersion: string;
  workerEntry: string;
  catalog?: readonly OfficialPlugin[];
  fetch?: typeof globalThis.fetch;
  hooks(id: string): HostedSwitchHooks;
  legacy?(id: string): (request: HostedInvocation) => Promise<unknown>;
}
export interface ManagedHostedPlugin {
  id: string; name: string; description: { zh: string; en: string }; official: true;
  installed: boolean; installedVersions: string[]; version: string | null; activeVersion: string | null;
  enabled: boolean; phase: string; generation: number | null; pendingVersion: string | null;
  updatePolicy: UpdatePolicy; availableVersion: string | null; error?: ReturnType<typeof failure>;
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
  private closing = false;
  constructor(options: HostedManagerOptions) {
    this.options = options;
    this.installer = new HostedPluginInstaller({ root: join(options.root, "packages"), hostVersion: options.hostVersion, catalog: options.catalog, fetch: options.fetch });
    for (const plugin of this.installer.catalog) {
      const broker = new HostedStateBroker(join(options.root, "data"), plugin.id, options.legacy?.(plugin.id));
      const hooks = options.hooks(plugin.id);
      this.supervisors.set(plugin.id, new HostedPluginSupervisor(broker, options.workerEntry, {
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
    const result = (this.operations.get(id) ?? Promise.resolve()).then(run, run);
    this.operations.set(id, result);
    void result.then(() => this.errors.delete(id), error => { this.errors.set(id, failure(error)); }).finally(() => { if (this.operations.get(id) === result) this.operations.delete(id); });
    return result;
  }
  private async policies(): Promise<Record<string, Policy>> {
    const value = await readJson<Record<string, Policy>>(join(this.options.root, "policies", "policies.json"));
    if (!value) return {};
    for (const [id, p] of Object.entries(value)) {
      officialPlugin(id, this.installer.catalog);
      if (!p || !["notify", "automatic", "pinned"].includes(p.updatePolicy) || p.pinnedVersion && !/^\d+\.\d+\.\d+$/.test(p.pinnedVersion)) throw new HostedPluginError("invalid_storage", "Invalid plugin update policy");
    }
    return value;
  }
  async setPolicy(id: string, policy: Policy): Promise<void> {
    this.supervisor(id);
    if (!["notify", "automatic", "pinned"].includes(policy.updatePolicy) || policy.pinnedVersion && !/^\d+\.\d+\.\d+$/.test(policy.pinnedVersion)) throw new HostedPluginError("invalid_input", "Invalid plugin update policy");
    await withStorageLock(join(this.options.root, "policies"), async () => {
      const policies = await this.policies(); policies[id] = policy;
      await atomicJson(join(this.options.root, "policies", "policies.json"), policies);
    });
  }
  /** Offline startup: catalog absence never downloads editor code; failures remain visible. */
  async start(): Promise<void> {
    await this.installer.inventory();
    for (const plugin of this.installer.catalog) {
      const s = this.supervisor(plugin.id), active = await s.broker.active();
      if (!active?.enabled) continue;
      try {
        const pkg = await this.installer.load(plugin.id, active.version);
        await s.replace(pkg); this.packages.set(plugin.id, pkg);
      } catch (error) { this.errors.set(plugin.id, failure(error)); }
    }
  }
  async inventory(): Promise<{ plugins: ManagedHostedPlugin[]; errors: string[] }> {
    const installed = await this.installer.inventory(), policies = await this.policies();
    const plugins = await Promise.all(this.installer.catalog.map(async plugin => {
      const s = this.supervisor(plugin.id), active = await s.broker.active(), pkg = this.packages.get(plugin.id);
      const versions = (installed.versions[plugin.id] ?? []).map(v => v.version).sort((a, b) => compareVersions(b, a));
      return {
        id: plugin.id, name: plugin.name, description: plugin.description, official: true as const,
        installed: !!versions.length, installedVersions: versions, version: versions[0] ?? null,
        activeVersion: active?.version ?? null, enabled: active?.enabled ?? false,
        phase: s.phase, generation: s.generation, pendingVersion: s.pendingVersion,
        updatePolicy: policies[plugin.id]?.updatePolicy ?? "notify", availableVersion: this.available.get(plugin.id)?.version ?? null,
        ...(this.errors.has(plugin.id) ? { error: this.errors.get(plugin.id)! } : {}),
        ...(pkg && s.phase === "active" ? { digest: pkg.digest, document: pkg.manifest.frontend.document.slice(2), controller: pkg.manifest.frontend.controller.slice(2), assetBase: `/hosted-plugins/${encodeURIComponent(plugin.id)}/${this.assetTokens.get(plugin.id)}/${pkg.digest}/` } : {}),
      };
    }));
    return { plugins, errors: [] };
  }
  get tools(): Array<{ pluginId: string; generation: number; descriptors: HostedToolDescriptor[] }> {
    return [...this.supervisors].flatMap(([pluginId, s]) => s.phase === "active" && s.generation !== null ? [{ pluginId, generation: s.generation, descriptors: s.tools }] : []);
  }
  async manage(id: string, operation: "install" | "enable" | "disable" | "update" | "uninstall" | "check" | "retry", version?: string): Promise<unknown> {
    return this.serialize(id, async () => {
      const s = this.supervisor(id), installed = (await this.installer.inventory()).versions[id] ?? [];
      const latest = installed.map(v => v.version).sort((a, b) => compareVersions(b, a))[0];
      switch (operation) {
        case "check": {
          const release = await this.installer.check(id, latest); this.available.set(id, release); return { version: release.version };
        }
        case "install": {
          const policy = (await this.policies())[id];
          const release = await this.installer.check(id, latest, version ?? policy?.pinnedVersion);
          const pkg = await this.installer.install(id, release); this.available.delete(id);
          // Installation and activation are separate: downloaded code is not silently enabled.
          return { installed: true, version: pkg.version };
        }
        case "enable": {
          const policy = (await this.policies())[id], selected = version ?? policy?.pinnedVersion ?? latest;
          if (!selected) throw new HostedPluginError("not_installed", "Install the plugin first");
          const pkg = await this.installer.load(id, selected), result = await s.replace(pkg);
          if (!result.pending) this.packages.set(id, pkg);
          return result;
        }
        case "retry": {
          const pending = s.pendingVersion, result = await s.retryPending();
          if (pending && !result.pending) this.packages.set(id, await this.installer.load(id, pending));
          return result;
        }
        case "disable": await s.disable(); this.packages.delete(id); return { enabled: false };
        case "update": {
          if (!latest) throw new HostedPluginError("not_installed", "Only installed plugins can be updated");
          const policy = (await this.policies())[id];
          if (policy?.updatePolicy === "pinned" && version !== policy.pinnedVersion) throw new HostedPluginError("version_pinned", "Plugin version is pinned; change its policy before updating");
          const release = await this.installer.check(id, latest, version), pkg = await this.installer.install(id, release);
          this.available.delete(id);
          const active = await s.broker.active();
          if (!active?.enabled) return { installed: true, enabled: false, version: pkg.version };
          const result = await s.replace(pkg); if (!result.pending) this.packages.set(id, pkg); return result;
        }
        case "uninstall": {
          await s.disable(); this.packages.delete(id);
          await this.installer.removeVersions(id, installed.map(v => v.version)); this.available.delete(id);
          return { installed: false, dataPreserved: true };
        }
        default: throw new HostedPluginError("invalid_operation", "Unknown plugin management operation");
      }
    });
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
    return pkg ? hostedAsset(pkg, path, digest) : null;
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
  /** Host-upgrade/startup reconciliation: only installed items; preserve disable and pin choices.
   * Registry failure never discards compatible local code. Incompatibility remains a visible error.
   */
  async reconcileHostUpgrade(): Promise<void> {
    const inventory = await this.installer.inventory(), policies = await this.policies();
    for (const plugin of this.installer.catalog) {
      const versions = inventory.versions[plugin.id]; if (!versions?.length) continue;
      if (policies[plugin.id]?.updatePolicy === "pinned") continue;
      try { await this.manage(plugin.id, "update"); }
      catch (error) { this.errors.set(plugin.id, failure(error)); }
    }
  }
  async shutdown(): Promise<void> {
    this.closing = true;
    await Promise.allSettled(this.operations.values());
    await Promise.all([...this.supervisors.values()].map(s => s.shutdown()));
    this.packages.clear(); this.assetTokens.clear();
  }
}
