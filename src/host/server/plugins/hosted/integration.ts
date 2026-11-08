import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { join } from "node:path";
import type { HostedScope, HostedToolDescriptor } from "@chengzhiyi/pi-web-protocol";
import type { HostedActionInput, HostedManageInput, HostedPluginCard, HostedPluginCatalog, HostedViewInput } from "../../../../contracts/hosted-plugins.ts";
import { HostedAgentAdapter, type HostedAgentPolicy } from "./agent-adapter.ts";
import { HostedPluginManager, type HostedManagerOptions } from "./manager.ts";
import { HostedViewCoordinator, type AuthenticatedViewScope } from "./views.ts";
import type { HostedBridgeHandlers } from "./routes.ts";
import { HostedStateBroker } from "./state-broker.ts";
import { invokeTimeoutFor, policyFor, workspaceRulesFor, type HostedPluginPolicy } from "./plugin-policies.ts";
import { hostedFrameCsp, manifestRequestsWasm } from "./frame-csp.ts";
import { toToolResult } from "./tool-result.ts";
import type { ExecuteApprovals } from "./capabilities/execute-approvals.ts";
import { parseDeclarations } from "./capabilities/declarations.ts";
import { DeviceFlows, secretAuthFor } from "./capabilities/oauth.ts";
import { HostedPluginError } from "./errors.ts";
import { atomicJson, privateDirectory, readJson } from "./storage.ts";
import { DEFAULT_POLICIES, OFFICIAL_PLUGINS } from "./official-catalog.ts";
import { HostedDevWatcher, type HostedDevSources } from "./dev-plugins.ts";

function declaredSecrets(manifest: unknown): string[] { try { return [...parseDeclarations(manifest).secrets]; } catch { return []; } }
export interface HostedIntegrationOptions extends Omit<HostedManagerOptions, "hooks" | "lifecycle"> {
  /** Single local bearer-authenticated principal, never supplied in a browser body. */
  ownerId: string;
  resolveSession(sessionId: string): HostedScope | null;
  policy?(pluginId: string, scope: HostedScope): Omit<HostedAgentPolicy, "enabled"> & { enabled?: boolean };
  changed?(): void;
  /** Reviewed per-plugin trust data, keyed by catalog id. Defaults to the built-in official policies. */
  policies?: ReadonlyMap<string, HostedPluginPolicy>;
  /** Pending human approvals, surfaced in the catalog and answered through `handlers.decide`. */
  approvals?: ExecuteApprovals;
  /** Developer opt-in: sources are polled and applied through the normal `update` switch. Absent in production. */
  dev?: HostedDevSources;
  /** Developer status file (read by `pnpm dev` in plugin workspaces). */
  devStatusPath?: string;
  devPollMs?: number;
}
/** One process-wide management queue and Agent barrier for ALL hosted plugins. */
export class HostedPluginIntegration {
  readonly manager: HostedPluginManager;
  readonly adapter: HostedAgentAdapter;
  readonly handlers: HostedBridgeHandlers;
  private readonly views = new Map<string, HostedViewCoordinator>();
  private readonly documents = new Map<string, { document: string; controller: string; secrets: string[] }>();
  private queue: Promise<unknown> = Promise.resolve();
  private switches: Promise<unknown> = Promise.resolve();
  private readonly recovery = new Map<string, unknown>();
  private readonly deviceFlows = new DeviceFlows();
  private restartPreparation?: Promise<() => Promise<void>>;
  private restartResume?: () => Promise<void>;
  private closing = false;
  private started = false;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private readonly options: HostedIntegrationOptions;
  private readonly trusted: ReadonlyMap<string, HostedPluginPolicy>;
  private readonly devWatcher?: HostedDevWatcher;
  constructor(options: HostedIntegrationOptions) {
    this.options = options;
    this.trusted = options.policies ?? DEFAULT_POLICIES;
    if (options.dev?.enabled) {
      this.devWatcher = new HostedDevWatcher({ sources: options.dev, statusPath: options.devStatusPath, pollMs: options.devPollMs, changed: () => options.changed?.(),
        // The same serialized path as the "Update" button; editors reopen because a developer's own save must not wait on a click.
        switcher: { update: async pluginId => {
          // Never "update" what the user has not installed: the manager would record that as a failed update check on the card.
          const catalog = await this.inventory();
          return catalog.plugins.find(p => p.pluginId === pluginId)?.installed ? this.manage({ pluginId, operation: "update", reopenEditors: true }) : catalog;
        }, retry: pluginId => this.manage({ pluginId, operation: "retry", reopenEditors: true }) } });
    }
    this.adapter = new HostedAgentAdapter({
      policy: (id, scope) => {
        // Bindings are created by trusted SDK/TUI factories, including during construction
        // before a candidate is retained. Actual execution always revalidates retained scope.
        const policy = options.policy?.(id, scope);
        return { ...policy, enabled: !this.recovery.has(id) && this.manager.tools.some(t => t.pluginId === id) && policy?.enabled !== false };
      },
      invoke: async (id, request, signal) => {
        signal?.throwIfAborted();
        this.scope(request.scope.sessionId, request.scope);
        const live = this.manager.tools.find(t => t.pluginId === id);
        if (!live) throw new HostedPluginError("plugin_unavailable", "Hosted tool unavailable");
        const value = await this.manager.invoke(id, live.generation, request);
        return toToolResult(value) as never;
      },
    });
    this.manager = new HostedPluginManager({ ...options,
      workspaceRules: id => workspaceRulesFor(this.trusted, id),
      invokeTimeoutMs: id => invokeTimeoutFor(this.trusted, id),
      // Terminal intent belongs to the operation, not the mutable closing flag:
      // an enable still preparing when shutdown starts must not retain its freeze.
      lifecycle: (id, operation, shutdown) => this.lifecycle(id, operation, shutdown),
      hooks: id => ({
      canSwitch: () => this.coordinator(id).canSwitch(),
      validateCandidate: (descriptors: readonly HostedToolDescriptor[]) => {
        if (descriptors.length !== Object.keys(policyFor(this.trusted, id).tools).length) throw new HostedPluginError("unreviewed_tool", "Official tool set changed; review required");
        this.verifyTools(id, descriptors);
        this.adapter.validateChange(id, descriptors);
      },
      freeze: async () => {
        if (!this.adapter.isFrozen) throw new Error("Missing outer Agent settlement barrier");
        await this.coordinator(id).freeze();
      },
      committed: async active => {
        try {
          const descriptors = active.enabled ? this.manager.tools.find(t => t.pluginId === id)?.descriptors : [];
          if (!descriptors) throw new Error("Committed runtime descriptors missing");
          this.verifyTools(id, descriptors);
          if (active.enabled) {
            const pkg = await this.manager.installer.load(id, active.version);
            this.documents.set(id, { document: pkg.manifest.frontend.document.replace(/^\.\//, ""), controller: pkg.manifest.frontend.controller.replace(/^\.\//, ""), secrets: declaredSecrets(pkg.manifest) });
          } else this.documents.delete(id);
          this.adapter.change(id, descriptors);
          await this.coordinator(id).committed(active);
          options.changed?.();
          this.recovery.delete(id);
        } catch (error) {
          this.recovery.set(id, error);
          // The pointer already committed. Publish its generation only if all genuine
          // view acknowledgements exist; never roll back newly accepted state.
          await this.coordinator(id).committed(active).catch(() => {});
          throw error;
        }
      },
      resume: () => this.coordinator(id).resume(),
    }) });
    this.handlers = {
      inventory: () => this.inventory(), manage: input => this.manage(input),
      secret: async (pluginId, name, value) => {
        const store = this.options.capabilities?.secrets, declared = this.documents.get(pluginId)?.secrets;
        if (!store) throw new HostedPluginError("hosted_unavailable", "Secrets are not available", { status: 503 });
        if (!declared?.includes(name)) throw new HostedPluginError("secret_undeclared", "The enabled plugin does not declare this secret", { status: 404 });
        if (value === null) await store.delete(pluginId, name); else await store.set(pluginId, name, value);
        this.options.changed?.();
        return this.inventory();
      },
      secretAuth: async input => {
        const store = this.options.capabilities?.secrets;
        if (!store) throw new HostedPluginError("hosted_unavailable", "Secrets are not available", { status: 503 });
        if (input.phase === "cancel") { this.deviceFlows.cancel(input.deviceId); return { status: "cancelled" }; }
        if (input.phase === "start") {
          const auth = this.documents.get(input.pluginId)?.secrets.includes(input.name) ? secretAuthFor(this.trusted.get(input.pluginId), input.name) : undefined;
          if (!auth) throw new HostedPluginError("secret_undeclared", "The enabled plugin does not declare browser sign-in for this secret", { status: 404 });
          return this.deviceFlows.start(input.pluginId, input.name, auth);
        }
        const result = await this.deviceFlows.poll(input.deviceId);
        if (result.status !== "granted") return { status: result.status };
        await store.set(result.pluginId, result.name, result.token);
        this.options.changed?.();
        return { status: "granted", catalog: await this.inventory() };
      },
      decide: (id, allow) => { if (!this.options.approvals) throw new HostedPluginError("hosted_unavailable", "Approvals are not available", { status: 503 }); this.options.approvals.decide(id, allow); return this.inventory(); },
      action: (input, options) => this.action(input, options?.checkpointOnly),
      views: async body => {
        if (body.operation === "list-pending") {
          if (typeof body.pluginId !== "string") throw new HostedPluginError("invalid_input", "Invalid plugin identity", { status: 400 });
          return { views: this.coordinator(body.pluginId).pendingViews(this.options.ownerId) };
        }
        const input = body as unknown as HostedViewInput;
        const scope = this.scope(input.sessionId);
        // Existing status/flush capabilities must survive supervisor draining;
        // the coordinator fences CHANGE against its committed generation itself.
        if (input.operation === "register") this.generation(input.pluginId, input.generation);
        return this.coordinator(input.pluginId).handle(input, this.viewScope(scope));
      },
      asset: async path => {
        const asset = await this.manager.assetRequest(path);
        if (!asset) return null;
        // Both the reviewed host policy and the served package must ask for WebAssembly.
        const wasm = this.trusted.get(asset.pluginId)?.browser?.wasm === true && manifestRequestsWasm(this.manager.servedManifest(asset.pluginId));
        return { bytes: asset.bytes, mime: asset.mime, csp: hostedFrameCsp({ wasm }) };
      },
    };
  }
  private verifyTools(id: string, descriptors: readonly HostedToolDescriptor[]) {
    const policy = policyFor(this.trusted, id);
    for (const tool of descriptors) {
      if (!Object.hasOwn(policy.tools, tool.name) || policy.tools[tool.name] !== tool.action || tool.readonly !== policy.readonlyActions.includes(tool.action)) throw new HostedPluginError("unreviewed_tool", "Official tool ownership/readonly policy changed; review required");
    }
  }
  private coordinator(id: string) {
    const value = this.views.get(id);
    if (!value) throw new HostedPluginError("unknown_plugin", "Hosted coordinator unavailable");
    return value;
  }
  private scope(id: string, expected?: HostedScope): HostedScope {
    const scope = typeof id === "string" ? this.options.resolveSession(id) : null;
    if (!scope || scope.sessionId !== id || !scope.cwd || !scope.workspaceId || expected && (scope.cwd !== expected.cwd || scope.workspaceId !== expected.workspaceId)) throw new HostedPluginError("invalid_scope", "Session is not retained by this authenticated host", { status: 403 });
    return { ...scope };
  }
  private viewScope(scope: HostedScope): AuthenticatedViewScope { return { ownerId: this.options.ownerId, workspaceId: scope.workspaceId, sessionId: scope.sessionId }; }
  private generation(id: string, generation: number) {
    const live = this.manager.tools.find(t => t.pluginId === id);
    if (!live || live.generation !== generation) throw new HostedPluginError("stale_generation", "Reconnect and re-handshake hosted views", { status: 409 });
    return live;
  }
  /** Serialize management intent without freezing Agent/UI admission during downloads. */
  private enqueue<T>(operation: () => Promise<T>, shutdown = false): Promise<T> {
    const result = this.queue.then(async () => {
      if (this.closing && !shutdown) throw new HostedPluginError("manager_closed", "Host is shutting down");
      return operation();
    });
    this.queue = result.catch(() => {});
    return result;
  }
  private lifecycle<T>(id: string, operation: () => Promise<T>, shutdown = false): Promise<T> {
    const result = this.switches.then(async () => {
      if (this.closing && !shutdown) throw new HostedPluginError("manager_closed", "Host is shutting down");
      try {
        if (!this.adapter.isFrozen) await this.adapter.freeze();
        const result = await operation();
        if (result && typeof result === "object" && "reconnectRequired" in result && result.reconnectRequired) {
          // Manager bookkeeping may fail before our committed callback executes.
          // The broker already owns the new generation: quarantine this plugin
          // and publish that generation only through the genuine view barrier.
          if (!this.recovery.has(id)) this.recovery.set(id, new Error("Committed plugin publication requires recovery"));
          const active = await new HostedStateBroker(join(this.options.root, "data"), id).active();
          if (active) await this.coordinator(id).committed(active).catch(() => {});
        }
        if (this.recovery.has(id) && !shutdown) throw new HostedPluginError("reconnect_required", "Plugin publication failed; recover this plugin without restarting chat", { status: 503 });
        return result;
      } finally {
        // Host shutdown sets this once for every plugin and clears it only after the last one: a per-plugin
        // lifecycle must not revoke the consent that a later plugin's freeze still depends on.
        if (!shutdown) for (const view of this.views.values()) view.allowImmediateReopen(false);
        // Successful host shutdown retains the barrier until process exit. Every
        // failed/non-terminal plugin operation releases base-chat admission.
        if (!shutdown) this.adapter.thaw();
      }
    });
    this.switches = result.catch(() => {});
    return result.catch(error => { if (shutdown) this.adapter.thaw(); throw error; });
  }
  /** Host health admission waits for plugins at most `timeoutMs`. A slow or hung plugin start keeps
   * running in the background and reports on its own card; it never fails the host's startup. */
  async admit(timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = this.start().then(() => true);
    started.catch(() => {});
    try { return await Promise.race([started, new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); timer.unref?.(); })]); }
    finally { clearTimeout(timer); }
  }
  start(): Promise<void> {
    // One start at a time; a failed start can be retried by the next session start.
    this.starting ??= this.startOnce().catch(error => { this.starting = undefined; throw error; });
    return this.starting;
  }
  private async startOnce(): Promise<void> {
    if (this.started) return;
    await this.adapter.verifyCompatibility();
    for (const plugin of this.options.catalog ?? OFFICIAL_PLUGINS) {
      try {
        const active = await new HostedStateBroker(join(this.options.root, "data"), plugin.id).active();
        this.views.set(plugin.id, new HostedViewCoordinator(plugin.id, active?.generation ?? 0));
      } catch (error) {
        this.recovery.set(plugin.id, error);
        this.views.set(plugin.id, new HostedViewCoordinator(plugin.id, 0));
      }
    }
    await this.enqueue(async () => {
      await this.manager.start();
      if (this.recovery.size) return;
      const marker = join(this.options.root, "host-version.json");
      if ((await readJson<{ version: string }>(marker))?.version !== this.options.hostVersion) {
        // Per plugin: compatible installed code is kept; only a real range conflict consults the registry.
        const synchronized = await this.manager.reconcileHostUpgrade();
        if (synchronized) {
          await privateDirectory(this.options.root);
          await atomicJson(marker, { version: this.options.hostVersion });
        } // Failed registry/install checks retry on the next startup, never claim reconciliation.
      }
    }).catch(error => {
      // Optional plugin storage cannot own the lifetime of the base host. Keep
      // the bytes intact and expose the diagnostic through the plugin catalog.
      for (const plugin of this.options.catalog ?? OFFICIAL_PLUGINS) this.recovery.set(plugin.id, error);
      this.adapter.thaw();
    });
    this.started = true;
    this.devWatcher?.start();
  }
  /** Plugins that would be unavailable on a host version: shown before an update, never blocking it. */
  hostUpdateWarnings(version: string): Promise<Array<{ pluginId: string; message: string }>> {
    return this.manager.hostUpdateWarnings(version);
  }
  async inventory(): Promise<HostedPluginCatalog> {
    const inventory = await this.manager.inventory();
    const store = this.options.capabilities?.secrets;
    const secrets = new Map<string, NonNullable<HostedPluginCard["secrets"]>>();
    for (const p of inventory.plugins) {
      const names = p.enabled ? this.documents.get(p.id)?.secrets ?? [] : [];
      if (store && names.length) secrets.set(p.id, await Promise.all(names.map(async name => { const auth = secretAuthFor(this.trusted.get(p.id), name); return { name, configured: await store.has(p.id, name), ...(auth ? { signIn: auth.clientId ? "browser" as const : "token-page" as const, ...(auth.createUrl ? { createUrl: auth.createUrl } : {}) } : {}) }; })));
    }
    return { ...(this.devWatcher ? { dev: this.devWatcher.info() } : {}), plugins: inventory.plugins.map(p => ({
      pluginId: p.id, name: p.name, official: p.official, installed: p.installed, enabled: p.enabled,
      description: p.description, ...(secrets.has(p.id) ? { secrets: secrets.get(p.id) } : {}),
      icon: (this.options.catalog ?? OFFICIAL_PLUGINS).find(plugin => plugin.id === p.id)?.icon,
      hasRetainedData: p.activeVersion !== null,
      phase: this.recovery.has(p.id) ? "reconnect-required" : p.phase,
      updatePolicy: p.updatePolicy, pinnedVersion: p.pinnedVersion, updateDiagnostic: p.updateDiagnostic,
      // A disabled runtime's historical active pointer is not the installed release.
      ...(p.enabled && p.activeVersion ? { version: p.activeVersion } : p.version ? { version: p.version } : {}),
      ...(p.availableVersion ? { availableVersion: p.availableVersion } : {}), ...(p.pendingVersion ? { pendingVersion: p.pendingVersion } : {}),
      ...(p.generation !== null ? { generation: p.generation } : {}),
      ...(this.recovery.has(p.id) || p.error ? { error: this.recovery.get(p.id) instanceof Error ? (this.recovery.get(p.id) as Error).message : p.error?.message ?? "Recovery required", errorCode: this.recovery.has(p.id) ? "reconnect_required" : p.error?.code } : {}),
      ...(p.enabled && p.assetBase && this.documents.has(p.id) && this.trusted.has(p.id) ? {
        documentUrl: p.assetBase + this.documents.get(p.id)!.document, controllerUrl: p.assetBase + this.documents.get(p.id)!.controller, contribution: structuredClone(this.trusted.get(p.id)!.contribution),
      } : {}),
    })), ...(this.options.approvals?.pending().length ? { approvals: this.options.approvals.pending() } : {}) };
  }
  private readonly downloads = new Map<string, { id: string; abort: AbortController }>();
  async manage(input: HostedManageInput): Promise<HostedPluginCatalog> {
    if (input.operation === "cancel-download") {
      const pending = this.downloads.get(input.pluginId);
      if (!pending || pending.id !== input.downloadId) throw new HostedPluginError("download_not_pending", "This download is no longer pending; refresh to verify its outcome", { status: 409 });
      pending.abort.abort(new HostedPluginError("download_cancelled", "Download cancellation requested; already committed installations are retained", { status: 409 }));
      return this.inventory();
    }
    const download = input.downloadId && ["install", "update", "check"].includes(input.operation) ? { id: input.downloadId, abort: new AbortController() } : undefined;
    if (download) {
      if (this.downloads.has(input.pluginId)) throw new HostedPluginError("download_pending", "Another download is pending", { status: 409 });
      this.downloads.set(input.pluginId, download);
    }
    try { await this.enqueue(async () => {
      const view = this.coordinator(input.pluginId);
      // Explicit disable/uninstall closes editors after flush; it is not an automatic update.
      view.allowImmediateReopen(input.reopenEditors === true || input.operation === "disable" || input.operation === "uninstall");
      try {
        if (input.operation === "policy") {
          if (!input.updatePolicy) throw new HostedPluginError("invalid_input", "Update policy is required");
          await this.manager.setPolicy(input.pluginId, { updatePolicy: input.updatePolicy, ...(input.updatePolicy === "pinned" ? { pinnedVersion: input.version } : {}) });
          return;
        }
        const result = await this.manager.manage(input.pluginId, input.operation as Exclude<HostedManageInput["operation"], "policy" | "cancel-download">, input.version, download?.abort.signal);
        if (this.recovery.has(input.pluginId) || result && typeof result === "object" && "reconnectRequired" in result && result.reconnectRequired) throw new HostedPluginError("reconnect_required", "Runtime committed but publication failed; explicit recovery required", { status: 503 });
      } finally { view.allowImmediateReopen(false); }
    });
    this.options.changed?.();
    this.devWatcher?.invalidate(input.pluginId); // an install/enable/update by hand changes what "synced" means: re-evaluate on the next poll
    return this.inventory();
    } finally { if (download && this.downloads.get(input.pluginId) === download) this.downloads.delete(input.pluginId); }
  }
  private async action(input: HostedActionInput, checkpointOnly = false): Promise<unknown> {
    const scope = this.scope(input.sessionId);
    if (!this.trusted.get(input.pluginId)?.actions.includes(input.action)) throw new HostedPluginError("action_denied", "Action is not reviewed by this host", { status: 403 });
    const release = this.coordinator(input.pluginId).admitAction(input, this.viewScope(scope));
    try {
      const request = { requestId: randomUUID(), scope, action: input.action, input: input.input ?? {} };
      if (this.adapter.isFrozen || checkpointOnly) {
        if (this.adapter.isFrozen && this.trusted.get(input.pluginId)!.checkpointActions.includes(input.action) && this.coordinator(input.pluginId).authorizesFlush(input, this.viewScope(scope))) return await this.manager.flush(input.pluginId, input.generation, request);
        throw new HostedPluginError("plugin_unavailable", "Only authenticated barrier checkpoint actions are admitted during switching", { status: 409 });
      }
      if (this.recovery.has(input.pluginId)) throw new HostedPluginError("plugin_unavailable", "Plugin publication recovery required", { status: 503 });
      this.generation(input.pluginId, input.generation);
      return await this.manager.invoke(input.pluginId, input.generation, { ...request, kind: "action" });
    } finally { release(); }
  }
  /** Keep the view identities and data generation alive until the launcher commits.
   * The returned undo lease is idempotent and recreates only verified old workers.
   */
  prepareRestart(force = false): Promise<() => Promise<void>> {
    if (this.restartPreparation) return this.restartPreparation;
    this.restartPreparation = this.enqueue(async () => {
      this.closing = true; this.devWatcher?.stop();
      try {
        await this.adapter.freeze();
        for (const view of this.views.values()) view.allowImmediateReopen(true);
        const restore = await this.manager.suspendForRestart(force);
        let restored = false;
        const resume = async () => {
          if (restored) return;
          try { await restore(); restored = true; }
          finally {
            this.closing = false; this.restartResume = undefined; this.restartPreparation = undefined;
            this.adapter.thaw(); this.devWatcher?.start();
          }
        };
        this.restartResume = resume;
        return resume;
      } catch (error) {
        this.closing = false; this.restartPreparation = undefined; this.adapter.thaw(); this.devWatcher?.start();
        throw error;
      } finally { for (const view of this.views.values()) view.allowImmediateReopen(false); }
    });
    return this.restartPreparation;
  }
  shutdown(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.devWatcher?.stop();
    if (this.restartResume) {
      // The reversible drain already stopped every worker. Process exit consumes
      // the lease; repeating freeze would wait on the same view barrier twice.
      for (const view of this.views.values()) view.dispose();
      this.stopping = Promise.resolve();
      return this.stopping;
    }
    this.closing = true;
    this.stopping = this.enqueue(async () => {
      for (const view of this.views.values()) view.allowImmediateReopen(true);
      await this.manager.shutdown();
      for (const view of this.views.values()) view.dispose();
    }, true).then(() => this.devWatcher?.idle()).catch(error => {
      for (const view of this.views.values()) view.allowImmediateReopen(false);
      this.closing = false; this.stopping = undefined; this.adapter.thaw(); this.devWatcher?.start();
      throw error;
    });
    return this.stopping;
  }
}
