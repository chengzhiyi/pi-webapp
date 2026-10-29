import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { join } from "node:path";
import type { HostedScope, HostedToolDescriptor } from "@chengzhiyi/pi-web-protocol";
import type { HostedActionInput, HostedContribution, HostedManageInput, HostedPluginCatalog, HostedViewInput } from "../../../../contracts/hosted-plugins.ts";
import { HostedAgentAdapter, type HostedAgentPolicy } from "./agent-adapter.ts";
import { HostedPluginManager, type HostedManagerOptions } from "./manager.ts";
import { HostedViewCoordinator, type AuthenticatedViewScope } from "./views.ts";
import type { HostedBridgeHandlers } from "./routes.ts";
import { HostedStateBroker } from "./state-broker.ts";
import { HostedPluginError } from "./errors.ts";
import { atomicJson, privateDirectory, readJson } from "./storage.ts";
import { OFFICIAL_PLUGINS } from "./official-catalog.ts";

const ID = "@chengzhiyi/pi-excalidraw";
// Reviewed data from package 6328c63, not imported domain code or frontend authorization.
const contribution: HostedContribution = {
  entry: { label: "Excalidraw", description: { zh: "手绘图稿", en: "Editable drawings" }, kind: "workspace" },
  panels: ["workspace", "editor"], artifactTools: ["excalidraw_create_view", "diagram_create", "diagram_patch"],
  toolViews: ["excalidraw_create_view", "diagram_create", "diagram_patch"], panelAlias: { prefix: "diagram:", kind: "editor", title: "Excalidraw" },
};
const tools = new Map(Object.entries({ excalidraw_read_me: "reference", excalidraw_create_view: "view", diagram_reference: "reference", diagram_create: "create", diagram_read: "read", diagram_patch: "patch" }));
const actions = new Set(["list", "new", "open", "import", "get", "focus", "sync", "initialize", "accept", "reject", "save"]);
const checkpoints = new Set(["sync", "get", "list"]);
export interface HostedIntegrationOptions extends Omit<HostedManagerOptions, "hooks" | "lifecycle"> {
  /** Single local bearer-authenticated principal, never supplied in a browser body. */
  ownerId: string;
  resolveSession(sessionId: string): HostedScope | null;
  policy?(pluginId: string, scope: HostedScope): Omit<HostedAgentPolicy, "enabled"> & { enabled?: boolean };
  changed?(): void;
}
/** One process-wide management queue and Agent barrier for ALL hosted plugins. */
export class HostedPluginIntegration {
  readonly manager: HostedPluginManager;
  readonly adapter: HostedAgentAdapter;
  readonly handlers: HostedBridgeHandlers;
  private readonly views = new Map<string, HostedViewCoordinator>();
  private readonly documents = new Map<string, { document: string; controller: string }>();
  private queue: Promise<unknown> = Promise.resolve();
  private switches: Promise<unknown> = Promise.resolve();
  private readonly recovery = new Map<string, unknown>();
  private restartPreparation?: Promise<() => Promise<void>>;
  private restartResume?: () => Promise<void>;
  private closing = false;
  private started = false;
  private stopping?: Promise<void>;
  private readonly options: HostedIntegrationOptions;
  constructor(options: HostedIntegrationOptions) {
    this.options = options;
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
        return { content: [{ type: "text", text: JSON.stringify(value) ?? "null" }], details: value };
      },
    });
    this.manager = new HostedPluginManager({ ...options,
      // Terminal intent belongs to the operation, not the mutable closing flag:
      // an enable still preparing when shutdown starts must not retain its freeze.
      lifecycle: (id, operation, shutdown) => this.lifecycle(id, operation, shutdown),
      hooks: id => ({
      canSwitch: () => this.coordinator(id).canSwitch(),
      validateCandidate: (descriptors: readonly HostedToolDescriptor[]) => {
        if (descriptors.length !== tools.size) throw new HostedPluginError("unreviewed_tool", "Official tool set changed; review required");
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
            this.documents.set(id, { document: pkg.manifest.frontend.document.replace(/^\.\//, ""), controller: pkg.manifest.frontend.controller.replace(/^\.\//, "") });
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
      action: (input, options) => this.action(input, options?.checkpointOnly),
      views: async body => {
        const input = body as unknown as HostedViewInput;
        const scope = this.scope(input.sessionId);
        // Existing status/flush capabilities must survive supervisor draining;
        // the coordinator fences CHANGE against its committed generation itself.
        if (input.operation === "register") this.generation(input.pluginId, input.generation);
        return this.coordinator(input.pluginId).handle(input, this.viewScope(scope));
      },
      asset: path => this.manager.assetRequest(path),
    };
  }
  private verifyTools(id: string, descriptors: readonly HostedToolDescriptor[]) {
    if (id !== ID) throw new HostedPluginError("unreviewed_plugin", "No trusted tool policy for this package");
    for (const tool of descriptors) {
      if (tools.get(tool.name) !== tool.action || tool.readonly !== ["read", "reference"].includes(tool.action)) throw new HostedPluginError("unreviewed_tool", "Official tool ownership/readonly policy changed; review required");
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
        for (const view of this.views.values()) view.allowImmediateReopen(false);
        // Successful host shutdown retains the barrier until process exit. Every
        // failed/non-terminal plugin operation releases base-chat admission.
        if (!shutdown) this.adapter.thaw();
      }
    });
    this.switches = result.catch(() => {});
    return result.catch(error => { if (shutdown) this.adapter.thaw(); throw error; });
  }
  async start(): Promise<void> {
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
        // Controlled selection already staged/admitted this exact combination offline.
        // Do not immediately replace it with a second registry-derived startup selection.
        const synchronized = this.manager.pairAdmitted
          ? !(await this.manager.inventory()).plugins.some(plugin => plugin.updateDiagnostic?.status === "failed")
          : await this.manager.reconcileHostUpgrade();
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
  }
  /** Legacy conservative compatibility check, NOT a paired updater. Production SelfUpdater
   * uses manager.hostPair to stage and fence the complete selection/restart transaction. */
  async validateHostUpdate(version: string, packageRoot: string): Promise<void> {
    await this.enqueue(async () => {
      if (await this.manager.validateHostUpdate(version)) {
        try { await access(join(packageRoot, "dist", "hosted-worker.js")); }
        catch { throw new HostedPluginError("host_pair_required", "Selected host has no hosted worker; keep current host/plugin pair"); }
      }
    });
  }
  async inventory(): Promise<HostedPluginCatalog> {
    const inventory = await this.manager.inventory();
    return { plugins: inventory.plugins.map(p => ({
      pluginId: p.id, name: p.name, official: p.official, installed: p.installed, enabled: p.enabled,
      icon: OFFICIAL_PLUGINS.find(plugin => plugin.id === p.id)?.icon,
      hasRetainedData: p.activeVersion !== null,
      phase: this.recovery.has(p.id) ? "reconnect-required" : p.phase,
      updatePolicy: p.updatePolicy, pinnedVersion: p.pinnedVersion, updateDiagnostic: p.updateDiagnostic,
      // A disabled runtime's historical active pointer is not the installed release.
      ...(p.enabled && p.activeVersion ? { version: p.activeVersion } : p.version ? { version: p.version } : {}),
      ...(p.availableVersion ? { availableVersion: p.availableVersion } : {}), ...(p.pendingVersion ? { pendingVersion: p.pendingVersion } : {}),
      ...(p.generation !== null ? { generation: p.generation } : {}),
      ...(this.recovery.has(p.id) || p.error ? { error: this.recovery.get(p.id) instanceof Error ? (this.recovery.get(p.id) as Error).message : p.error?.message ?? "Recovery required", errorCode: this.recovery.has(p.id) ? "reconnect_required" : p.error?.code } : {}),
      ...(p.enabled && p.assetBase && this.documents.has(p.id) && p.id === ID ? {
        documentUrl: p.assetBase + this.documents.get(p.id)!.document, controllerUrl: p.assetBase + this.documents.get(p.id)!.controller, contribution: structuredClone(contribution),
      } : {}),
    })) };
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
    return this.inventory();
    } finally { if (download && this.downloads.get(input.pluginId) === download) this.downloads.delete(input.pluginId); }
  }
  private async action(input: HostedActionInput, checkpointOnly = false): Promise<unknown> {
    const scope = this.scope(input.sessionId);
    if (input.pluginId !== ID || !actions.has(input.action)) throw new HostedPluginError("action_denied", "Action is not reviewed by this host", { status: 403 });
    const release = this.coordinator(input.pluginId).admitAction(input, this.viewScope(scope));
    try {
      const request = { requestId: randomUUID(), scope, action: input.action, input: input.input ?? {} };
      if (this.adapter.isFrozen || checkpointOnly) {
        if (this.adapter.isFrozen && checkpoints.has(input.action) && this.coordinator(input.pluginId).authorizesFlush(input, this.viewScope(scope))) return await this.manager.flush(input.pluginId, input.generation, request);
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
  prepareRestart(): Promise<() => Promise<void>> {
    if (this.restartPreparation) return this.restartPreparation;
    this.restartPreparation = this.enqueue(async () => {
      this.closing = true;
      try {
        await this.adapter.freeze();
        for (const view of this.views.values()) view.allowImmediateReopen(true);
        const restore = await this.manager.suspendForRestart();
        let restored = false;
        const resume = async () => {
          if (restored) return;
          try { await restore(); restored = true; }
          finally {
            this.closing = false; this.restartResume = undefined; this.restartPreparation = undefined;
            this.adapter.thaw();
          }
        };
        this.restartResume = resume;
        return resume;
      } catch (error) {
        this.closing = false; this.restartPreparation = undefined; this.adapter.thaw();
        throw error;
      } finally { for (const view of this.views.values()) view.allowImmediateReopen(false); }
    });
    return this.restartPreparation;
  }
  shutdown(): Promise<void> {
    if (this.stopping) return this.stopping;
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
    }, true).catch(error => {
      this.closing = false; this.stopping = undefined; this.adapter.thaw();
      throw error;
    });
    return this.stopping;
  }
}
