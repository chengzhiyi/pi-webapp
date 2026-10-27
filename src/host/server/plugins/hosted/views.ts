import { randomUUID } from "node:crypto";
import type { HostedViewInput, HostedViewCommand, HostedViewReply, HostedViewIdentity, HostedActionInput } from "../../../../contracts/hosted-plugins.ts";

/** Supplied by the route AFTER authenticating session/workspace access, never from JSON cwd. */
export interface AuthenticatedViewScope { ownerId: string; workspaceId: string; sessionId: string }
interface View {
  identity: HostedViewIdentity; scope: AuthenticatedViewScope; token: string; kind: string;
  dirty: boolean; busy: boolean; frozen: boolean; commands: HostedViewCommand[];
  activeActions?: number;
  waiter?: () => void;
}
interface Barrier { id: number; pending: Set<string>; resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
const fail = (message: string) => Object.assign(new Error(message), { status: 409, code: "view_barrier" });
/** One coordinator per plugin. No dirty-view TTL: lost clients require explicit recovery, not silent success. */
export class HostedViewCoordinator {
  private views = new Map<string, View>();
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
  canSwitch = () => [...this.views.values()].every(view => this.switching
    ? view.frozen && !view.dirty && !view.busy
    : view.frozen || (!view.busy && (this.immediate || !["editor", "workspace"].includes(view.kind))));
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
    view.activeActions = (view.activeActions ?? 0) + 1;
    return () => { view.activeActions!--; };
  }
  private enqueue(view: View, type: HostedViewCommand["type"], id = ++this.sequence) {
    view.commands.push({ id, type, generation: this.generation }); view.waiter?.(); return id;
  }
  async handle(input: HostedViewInput, scope: AuthenticatedViewScope): Promise<HostedViewReply> {
    if (!input || input.pluginId !== this.pluginId || input.sessionId !== scope.sessionId || !scope.ownerId || !scope.workspaceId || typeof input.mountId !== "string" || input.mountId.length > 200 || !input.mountId) throw fail("Invalid authenticated view scope");
    if (input.operation === "register") {
      if (this.switching || input.generation !== this.generation) throw fail("Generation is switching; reconnect");
      if (!["controller", "workspace", "editor", "tool"].includes(input.kind)) throw fail("Invalid mount kind");
      if ([...this.views.values()].some(view => view.scope.ownerId === scope.ownerId && view.identity.mountId === input.mountId)) throw fail("Duplicate mount");
      const token = randomUUID();
      // Unknown until initialized and changed/flush is acknowledged; conservative initial dirty state.
      this.views.set(token, { identity: { pluginId: input.pluginId, sessionId: input.sessionId, generation: input.generation, mountId: input.mountId }, scope: { ...scope }, token, kind: input.kind, dirty: true, busy: true, frozen: false, commands: [] });
      return { viewToken: token, commands: [] };
    }
    const view = this.views.get(input.viewToken);
    if (!view || view.scope.ownerId !== scope.ownerId || view.scope.workspaceId !== scope.workspaceId || view.identity.sessionId !== input.sessionId || view.identity.mountId !== input.mountId || view.identity.generation !== input.generation) throw fail("Unknown or stale view capability");
    switch (input.operation) {
      case "change":
        if (input.generation !== this.generation) throw fail("Generation changed; reconnect before publishing view status");
        if (typeof input.dirty !== "boolean" || typeof input.busy !== "boolean") throw fail("Invalid view status");
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
        view.waiter?.(); this.views.delete(view.token); break;
      case "close":
        if (view.activeActions) throw fail("View action still in flight");
        if ((view.dirty || view.busy) && !view.frozen) throw fail("Dirty view cannot close without a successful flush");
        if (this.barrier?.pending.has(view.token)) throw fail("View must acknowledge freeze before closing");
        view.waiter?.(); this.views.delete(view.token); break;
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
    if (!this.canSwitch()) throw fail("Close editors before updating; old version retained");
    this.switching = true;
    const id = ++this.sequence;
    try {
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => { if (this.barrier?.id !== id) return; clearTimeout(this.barrier.timer); this.barrier = null; error ? reject(error) : resolve(); };
        this.barrier = { id, pending: new Set(this.views.keys()), resolve: () => finish(), reject: error => finish(error), timer: setTimeout(() => finish(fail("Missing view flush acknowledgement; old version retained")), this.freezeMs) };
        for (const view of this.views.values()) this.enqueue(view, "freeze", id);
        if (!this.views.size) finish();
      });
    } catch (error) { await this.resume(); throw error; }
  };
  committed = async (active: { generation: number }) => {
    if (!this.switching || this.barrier || [...this.views.values()].some(view => !view.frozen)) throw fail("Cannot commit before all views freeze");
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
