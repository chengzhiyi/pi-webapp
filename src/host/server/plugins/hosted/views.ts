import { randomUUID } from "node:crypto";
import type { HostedViewInput, HostedViewCommand, HostedViewReply, HostedViewIdentity, HostedActionInput, HostedViewRecovery, HostedMount } from "../../../../contracts/hosted-plugins.ts";

/** Supplied by the route AFTER authenticating session/workspace access, never from JSON cwd. */
export interface AuthenticatedViewScope { ownerId: string; workspaceId: string; sessionId: string }
interface View {
  identity: HostedViewIdentity; scope: AuthenticatedViewScope; token: string; kind: HostedMount["kind"]; initialized: boolean;
  dirty: boolean; busy: boolean; frozen: boolean; commands: HostedViewCommand[];
  activeActions?: number;
  waiter?: () => void;
}
interface Barrier { id: number; pending: Set<string>; resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
const fail = (message: string) => Object.assign(new Error(message), { status: 409, code: "view_barrier" });
/** One coordinator per plugin. No dirty-view TTL: lost clients require explicit recovery, not silent success. */
export class HostedViewCoordinator {
  private views = new Map<string, View>();
  // Recovery records revoke admission but do not claim that a lost draft was saved.
  // Browser journals/backups remain the recovery source after a host restart.
  private recoveries = new Map<string, View>();
  private cancelledRegistrations = new Set<string>();
  // Completed close/discard receipts remain distinguishable from unknown tokens.
  private retired = new Map<string, Pick<View, "identity" | "scope">>();
  private sequence = 0;
  private barrier: Barrier | null = null;
  private switching = false;
  private immediate = false;
  readonly pluginId: string;
  private generation: number;
  private pollMs: number;
  private freezeMs: number;
  constructor(pluginId: string, generation: number, pollMs = 20_000, freezeMs = 15_000) {
    this.pluginId = pluginId; this.generation = generation; this.pollMs = pollMs; this.freezeMs = freezeMs;
  }
  /** Use only after the host's explicit undo-reset warning has been accepted. */
  allowImmediateReopen(accepted: boolean) { this.immediate = accepted; }
  canSwitch = () => [...this.views.values()].every(view => view.kind === "controller"
    ? !view.activeActions
    : this.switching ? view.frozen && !view.dirty && !view.busy
    : view.frozen || (!view.busy && (this.immediate || !["editor", "workspace"].includes(view.kind))));
  private authoringViews() { return [...this.views.values()].filter(view => view.kind !== "controller"); }
  private sameScope(view: Pick<View, "identity" | "scope">, input: HostedViewIdentity, scope: AuthenticatedViewScope) {
    return view.scope.ownerId === scope.ownerId && view.scope.workspaceId === scope.workspaceId
      && view.identity.sessionId === input.sessionId && view.identity.mountId === input.mountId && view.identity.generation === input.generation;
  }
  private recovery(view: View, state: HostedViewRecovery["state"]): HostedViewRecovery {
    return { state, kind: view.kind, dirty: view.dirty, busy: view.busy || !!view.activeActions };
  }
  /** Additionally require a host-owned checkpoint-only action allowlist before using supervisor.flushAction(). */
  authorizesFlush(input: HostedActionInput, scope: AuthenticatedViewScope): boolean {
    const view = input.viewToken ? this.views.get(input.viewToken) : undefined;
    return !!(this.barrier && view && this.barrier.pending.has(view.token)
      && input.pluginId === this.pluginId && input.generation === this.generation
      && view.identity.generation === input.generation && view.identity.mountId === input.mountId
      && view.identity.sessionId === input.sessionId && scope.sessionId === input.sessionId
      && view.scope.ownerId === scope.ownerId && view.scope.workspaceId === scope.workspaceId);
  }
  /** Fence revoked capabilities on ordinary actions too; no bypass outside barriers. */
  admitAction(input: HostedActionInput, scope: AuthenticatedViewScope): () => void {
    if (input.viewToken === undefined && input.mountId === undefined) return () => {}; // v1 trusted host actions
    const view = input.viewToken ? this.views.get(input.viewToken) : undefined;
    if (!view || view.identity.generation !== this.generation || input.generation !== view.identity.generation || input.mountId !== view.identity.mountId || input.sessionId !== view.identity.sessionId || scope.ownerId !== view.scope.ownerId || scope.workspaceId !== view.scope.workspaceId || scope.sessionId !== view.identity.sessionId) throw fail("Unknown or stale view action capability");
    if (this.switching && view.kind === "controller") throw fail("Controller admission paused during plugin switching");
    view.initialized = true;
    view.activeActions = (view.activeActions ?? 0) + 1;
    return () => { view.activeActions!--; };
  }
  private enqueue(view: View, type: HostedViewCommand["type"], id = ++this.sequence) {
    view.commands.push({ id, type, generation: this.generation }); view.waiter?.(); return id;
  }
  private retire(view: View) {
    view.waiter?.(); this.views.delete(view.token); this.cancelledRegistrations.add(view.token);
    this.retired.set(view.token, { identity: view.identity, scope: view.scope });
    if (this.retired.size > 1024) this.retired.delete(this.retired.keys().next().value!);
  }
  async handle(input: HostedViewInput, scope: AuthenticatedViewScope): Promise<HostedViewReply> {
    if (!input || input.pluginId !== this.pluginId || input.sessionId !== scope.sessionId || !scope.ownerId || !scope.workspaceId || typeof input.mountId !== "string" || input.mountId.length > 200 || !input.mountId) throw fail("Invalid authenticated view scope");
    if (input.operation === "register") {
      if (this.switching || input.generation !== this.generation) throw fail("Generation is switching; reconnect");
      if (!["controller", "workspace", "editor", "tool"].includes(input.kind)) throw fail("Invalid mount kind");
      if (input.viewToken !== undefined && (typeof input.viewToken !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.viewToken))) throw fail("Invalid registration capability");
      const token = input.viewToken ?? randomUUID();
      if (this.cancelledRegistrations.has(token) || this.recoveries.has(token)) throw fail("View initialization was cancelled; register a new document identity");
      const existing = this.views.get(token);
      if (existing) {
        if (!this.sameScope(existing, input, scope) || existing.kind !== input.kind) throw fail("Duplicate view capability");
        return { viewToken: token, commands: [] };
      }
      if ([...this.views.values()].some(view => view.scope.ownerId === scope.ownerId && view.identity.mountId === input.mountId)) throw fail("Duplicate mount");
      // Unknown until initialized and changed/flush is acknowledged; conservative initial dirty state.
      this.views.set(token, { identity: { pluginId: input.pluginId, sessionId: input.sessionId, generation: input.generation, mountId: input.mountId }, scope: { ...scope }, token, kind: input.kind, initialized: false, dirty: input.kind !== "controller", busy: input.kind !== "controller", frozen: false, commands: [] });
      return { viewToken: token, commands: [] };
    }
    if (typeof input.viewToken !== "string" || !input.viewToken || input.viewToken.length > 200) throw fail("Invalid view capability");
    const view = this.views.get(input.viewToken);
    const retained = this.recoveries.get(input.viewToken);
    const closed = this.retired.get(input.viewToken);
    if (closed && !this.sameScope(closed, input, scope)) throw fail("Unknown or stale view capability");
    if (input.operation === "reconcile" || input.operation === "recover") {
      if (view && !this.sameScope(view, input, scope) || retained && !this.sameScope(retained, input, scope)) throw fail("Unknown or stale view capability");
      if (retained) return { viewToken: input.viewToken, commands: [], recovery: this.recovery(retained, "retained") };
      if (closed) return { viewToken: input.viewToken, commands: [], recovery: { state: "retired" } };
      if (!view) {
        // Reconciliation may beat a late REGISTER whose response was lost at reload.
        // Fence that exact nonce so the abandoned request cannot resurrect a view.
        this.cancelledRegistrations.add(input.viewToken);
        return { viewToken: input.viewToken, commands: [], recovery: { state: "absent" } };
      }
      if (this.switching || view.activeActions) return { viewToken: view.token, commands: [], recovery: this.recovery(view, "active") };
      if (view.kind === "controller") {
        // A reviewed controller is a control plane with no user-editable local draft.
        // Its server-side actions have drained; no save/flush ACK is manufactured.
        view.waiter?.(); this.views.delete(view.token); this.cancelledRegistrations.add(view.token);
        return { viewToken: view.token, commands: [], recovery: this.recovery(view, "retired") };
      }
      if (input.operation === "recover") {
        if (input.confirmation !== "retain-unconfirmed-edits") throw fail("Explicit recovery confirmation required");
        view.waiter?.(); this.views.delete(view.token); this.cancelledRegistrations.add(view.token); this.recoveries.set(view.token, view);
        return { viewToken: view.token, commands: [], recovery: this.recovery(view, "retained") };
      }
      return { viewToken: view.token, commands: [], recovery: this.recovery(view, "unconfirmed") };
    }
    if (input.operation === "discard" && retained && this.sameScope(retained, input, scope)) {
      if (input.confirmation !== "discard-unconfirmed-edits") throw fail("Explicit per-view discard confirmation required");
      this.recoveries.delete(input.viewToken);
      return { viewToken: input.viewToken, commands: [] };
    }
    if (input.operation === "discard" && !view && !retained) {
      if (input.confirmation !== "discard-unconfirmed-edits") throw fail("Explicit per-view discard confirmation required");
      if (this.switching) throw fail("View has an active barrier or action; discard refused");
      // Explicit dismissal after a restart acknowledges no save and changes no drawing.
      this.cancelledRegistrations.add(input.viewToken);
      return { viewToken: input.viewToken, commands: [] };
    }
    if (!view || !this.sameScope(view, input, scope)) throw fail("Unknown or stale view capability");
    switch (input.operation) {
      case "cancel-initialization":
        if (view.initialized || view.activeActions || this.switching) throw fail("View already initialized; preserve its recovery record");
        this.retire(view); break;
      case "change":
        if (input.generation !== this.generation) throw fail("Generation changed; reconnect before publishing view status");
        if (typeof input.dirty !== "boolean" || typeof input.busy !== "boolean") throw fail("Invalid view status");
        view.initialized = true;
        view.dirty = input.dirty; view.busy = input.busy;
        if ((view.dirty || view.busy) && view.frozen) { view.frozen = false; this.barrier?.reject(fail("A frozen view changed")); }
        break;
      case "ack": {
        if (typeof input.ok !== "boolean") throw fail("Invalid acknowledgement");
        const command = view.commands.find(command => command.id === input.commandId);
        if (!command) throw fail("Unknown command acknowledgement");
        view.commands = view.commands.filter(item => item.id > input.commandId);
        if (command.type === "freeze" && this.barrier?.id === command.id) {
          if (!input.ok) this.barrier.reject(fail(input.error ?? "A view could not flush/freeze"));
          else { view.frozen = true; view.dirty = false; view.busy = false; this.barrier.pending.delete(view.token); if (!this.barrier.pending.size) this.barrier.resolve(); }
        }
        break;
      }
      case "discard":
        if (input.confirmation !== "discard-unconfirmed-edits") throw fail("Explicit per-view discard confirmation required");
        if (this.switching || view.activeActions) throw fail("View has an active barrier or action; discard refused");
        this.retire(view); break;
      case "close":
        if (view.activeActions) throw fail("View action still in flight");
        if (view.kind !== "controller" && (view.dirty || view.busy) && !view.frozen) throw fail("Dirty view cannot close without a successful flush");
        if (this.barrier?.pending.has(view.token)) throw fail("View must acknowledge freeze before closing");
        this.retire(view); break;
      case "poll": {
        if (!Number.isSafeInteger(input.after) || input.after < 0 || input.after > this.sequence) throw fail("Invalid poll cursor");
        if (view.waiter) throw fail("Only one poll per view is allowed");
        if (input.immediate !== undefined && typeof input.immediate !== "boolean") throw fail("Invalid poll mode");
        if (!input.immediate && !view.commands.some(command => command.id > input.after)) await new Promise<void>(resolve => {
          const timer = setTimeout(done, Math.min(25_000, Math.max(50, this.pollMs)));
          function done() { clearTimeout(timer); view!.waiter = undefined; resolve(); }
          view.waiter = done;
        });
        return { viewToken: view.token, commands: view.commands.filter(command => command.id > input.after) };
      }
      default: throw fail("Unknown view operation");
    }
    return { viewToken: view.token, commands: [] };
  }
  freeze = async () => {
    if (this.switching) throw fail("A view barrier is already active");
    if (!this.canSwitch()) {
      const blocked = [...this.views.values()].filter(view => view.activeActions || view.kind !== "controller" && !view.frozen && (view.busy || !this.immediate && ["editor", "workspace"].includes(view.kind)));
      throw fail(`Close editors before updating; old version retained. Pending views: ${blocked.map(view => `${view.kind}:${view.identity.mountId}`).join(", ")}`);
    }
    this.switching = true;
    const id = ++this.sequence;
    try {
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => { if (this.barrier?.id !== id) return; clearTimeout(this.barrier.timer); this.barrier = null; error ? reject(error) : resolve(); };
        this.barrier = { id, pending: new Set(this.authoringViews().map(view => view.token)), resolve: () => finish(), reject: error => finish(error), timer: setTimeout(() => {
          const pending = this.authoringViews().filter(view => this.barrier?.pending.has(view.token));
          finish(fail(`Missing view flush acknowledgement; old version retained. Plugin: ${this.pluginId}. Pending views: ${pending.map(view => `${view.kind}:${view.identity.mountId} (session ${view.identity.sessionId})`).join(", ")}. Save and close these views, or review their recovery records before retrying.`));
        }, this.freezeMs) };
        for (const view of this.authoringViews()) this.enqueue(view, "freeze", id);
        if (!this.authoringViews().length) finish();
      });
    } catch (error) { await this.resume(); throw error; }
  };
  committed = async (active: { generation: number }) => {
    if (!this.switching || this.barrier || this.authoringViews().some(view => !view.frozen)) throw fail("Cannot commit before all views freeze");
    this.generation = active.generation;
    for (const view of this.views.values()) this.enqueue(view, "committed");
    this.switching = false; this.immediate = false;
  };
  resume = async () => {
    this.barrier?.reject(fail("Switch cancelled"));
    for (const view of this.views.values()) { this.enqueue(view, "resume"); view.frozen = false; }
    this.switching = false; this.immediate = false;
  };
  dispose() { this.barrier?.reject(fail("Coordinator stopped")); for (const view of this.views.values()) view.waiter?.(); }
}
