import { randomUUID } from "node:crypto";
import { type AgentSession, type ExtensionAPI, type ExtensionFactory, type ToolDefinition, type ToolExposure } from "@earendil-works/pi-coding-agent";
import type { HostedScope, HostedToolDescriptor } from "@chengzhiyi/pi-web-protocol";
import { assessHostedSdk, verifyHostedSdkContract, type HostedSdkAssessment } from "./sdk-contract.ts";

export interface HostedAgentPolicy {
  enabled: boolean;
  allowlist?: readonly string[];
  planMode?: boolean;
  exposure?: "direct" | "model-only" | "codemode" | "deferred";
  allowNested?: boolean;
}
export interface HostedAgentService {
  /** Scope is host-authenticated, never read from tool input. Convert domain results here. */
  invoke(pluginId: string, request: { requestId: string; scope: HostedScope; kind: "tool" | "action"; action: string; input: unknown }, signal?: AbortSignal): ReturnType<ToolDefinition["execute"]>;
  policy(pluginId: string, scope: HostedScope): HostedAgentPolicy;
}
interface Binding {
  pi: ExtensionAPI;
  scope: HostedScope;
  busy: boolean;
  disposed: boolean;
  ready: boolean;
  compatible?: boolean;
  missing?: string[];
  handlers: Array<() => void>;
  owned: Map<string, string>;
  definitions: Map<string, ToolDefinition>;
  session?: AgentSession;
  off?: () => void;
}

/** One host-owned extension per AgentSession; no plugin code is imported into this realm. */
export class HostedAgentAdapter {
  private readonly bindings = new Set<Binding>();
  private readonly descriptors = new Map<string, HostedToolDescriptor[]>();
  private frozen = false;
  private readonly waiters = new Set<() => void>();
  private readonly admissionListeners = new Set<() => void>();
  onThaw(listener: () => void): () => void { this.admissionListeners.add(listener); return () => { this.admissionListeners.delete(listener); }; }
  private readonly service: HostedAgentService;
  private sdkContract?: HostedSdkAssessment;
  private verification?: Promise<HostedSdkAssessment>;
  verifyCompatibility(): Promise<HostedSdkAssessment> {
    return this.verification ??= verifyHostedSdkContract().then(result => {
      this.sdkContract = result;
      for (const binding of this.bindings) if (binding.ready && !binding.disposed) {
        try { this.publish(binding); } catch { binding.compatible = false; binding.missing = ["sdk-tool-publication"]; }
      }
      return result;
    });
  }
  constructor(service: HostedAgentService) {
    this.service = service;

  }
  get compatibilityIssues() { return [...this.bindings].filter(binding => binding.compatible === false).map(binding => ({ sessionId: binding.scope.sessionId, missing: binding.missing ?? [] })); }
  get isFrozen(): boolean { return this.frozen; }
  assertAdmission(): void { if (this.frozen) throw Object.assign(new Error("Hosted tools are switching; retry after thaw"), { code: "hosted_admission_blocked" }); }
  private notify(): void { for (const wake of this.waiters) wake(); this.waiters.clear(); }
  private async until(test: () => boolean): Promise<void> {
    while (!test()) await new Promise<void>(resolve => this.waiters.add(resolve));
  }
  /** Closes admission synchronously, then drains every retained session to agent_settled. */
  async freeze(timeoutMs = 30_000): Promise<void> {
    if (this.frozen) throw new Error("Hosted adapter already frozen");
    this.frozen = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.until(() => !this.frozen || [...this.bindings].every(binding => binding.compatible === false || !binding.busy)), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error("Hosted agent settlement timed out; current chat admission restored"), { code: "agent_settlement_timeout" })), timeoutMs);
      })]);
    } catch (error) { this.thaw(); throw error; }
    finally { clearTimeout(timer); }
  }
  thaw(): void { this.frozen = false; this.notify(); for (const listener of this.admissionListeners) listener(); }

  /** Use as an inline SDK extension or call from pi-host's long-lived TUI extension. */
  extension(scope: HostedScope): ExtensionFactory {
    return async pi => { await this.verifyCompatibility(); this.install(pi, scope); };
  }
  /** Call from the parent's TUI session_start with authenticated context scope. */
  mountTui(pi: ExtensionAPI, scope: HostedScope): () => void {
    const binding = this.install(pi, scope);
    binding.ready = true;
    try { this.publish(binding); } catch (error) { this.release(binding); throw error; }
    return () => this.release(binding);
  }
  private install(pi: ExtensionAPI, scope: HostedScope): Binding {
    const binding: Binding = { pi, scope: { ...scope }, busy: false, disposed: false, ready: false, handlers: [], owned: new Map(), definitions: new Map() };
    this.bindings.add(binding);
    if (typeof pi.on !== "function") { binding.compatible = false; binding.missing = ["on"]; return binding; }
    const listen = (unsubscribe: unknown) => {
      if (typeof unsubscribe !== "function") throw new Error("SDK event subscription cannot be released");
      binding.handlers.push(unsubscribe as () => void);
    };
    try {
      listen(pi.on("before_agent_start", async () => {
        // Automatic work belongs to an already-admitted run until final settlement.
        while (this.frozen && binding.compatible !== false && !binding.busy && !binding.disposed) await new Promise<void>(resolve => this.waiters.add(resolve));
        if (binding.disposed) throw new Error("Hosted session disposed");
        binding.busy = binding.compatible !== false;
      }));
      listen(pi.on("agent_settled", () => { binding.busy = false; this.notify(); }));
      listen(pi.on("tool_call", event => {
        const pluginId = binding.owned.get(event.toolName);
        if (!pluginId) return;
        const descriptor = this.descriptors.get(pluginId)?.find(tool => tool.name === event.toolName);
        if (!descriptor || !this.allowed(binding, pluginId, descriptor, !!event.parentToolCallId)) return { block: true, reason: "Hosted tool denied by host policy" };
      }));
      listen(pi.on("session_start", () => { binding.ready = true; this.publish(binding); }));
      listen(pi.on("session_shutdown", () => this.release(binding)));
    } catch {
      for (const off of binding.handlers) { try { off(); } catch {} } binding.handlers = [];
      binding.compatible = false; binding.missing = ["hosted-lifecycle-events"];
    }
    return binding;
  }
  /** Bind after createAgentSession, before exposing it to prompts. Includes background sessions. */
  attach(session: AgentSession): () => void {
    const binding = [...this.bindings].find(item => item.scope.sessionId === session.sessionManager.getSessionId() && !item.session);
    if (!binding) throw new Error("Hosted inline extension missing for this session");
    if (!session.isIdle) throw new Error("Cannot attach hosted adapter to a running session");
    binding.session = session;
    binding.ready = true;
    binding.off = session.subscribe(event => { if (event.type === "agent_settled") { binding.busy = false; this.notify(); } });
    try { this.publish(binding); } catch (error) { this.release(binding); throw error; }
    return () => this.release(binding);
  }
  /** Cleanup for a failed SDK construction before attach returned a disposer. */
  releasePending(sessionId: string): void {
    for (const binding of this.bindings) if (!binding.session && !binding.ready && binding.scope.sessionId === sessionId) this.release(binding);
  }
  private release(binding: Binding): void {
    if (binding.disposed) return;
    binding.disposed = true; binding.off?.();
    for (const off of binding.handlers) off();
    binding.handlers.length = 0; binding.definitions.clear();
    this.bindings.delete(binding); this.notify();
  }
  private allowed(binding: Binding, pluginId: string, tool: HostedToolDescriptor, nested = false): boolean {
    const policy = this.service.policy(pluginId, binding.scope);
    return this.sdkContract?.supported === true && binding.compatible === true && policy.enabled && (!policy.allowlist || policy.allowlist.includes(tool.name))
      && (!policy.planMode || tool.readonly === true) && (!nested || policy.allowNested === true);
  }
  /** Only while frozen and fully settled. Empty tools hides a plugin using host-only tombstones. */
  change(pluginId: string, tools: readonly HostedToolDescriptor[]): void {
    if (!this.frozen || [...this.bindings].some(binding => binding.busy)) throw new Error("Descriptor changes require frozen agent_settled boundary");
    const copy = structuredClone(tools) as HostedToolDescriptor[];
    this.validateChange(pluginId, copy);
    this.descriptors.set(pluginId, copy);
    for (const binding of this.bindings) if (binding.ready) this.publish(binding);
  }
  /** Parent preflight before supervisor commit; repeat at change to catch intervening owners. */
  validateChange(pluginId: string, tools: readonly HostedToolDescriptor[]): void {
    for (const binding of this.bindings) if (binding.compatible !== false) for (const [name, owner] of binding.owned) this.assertOwner(binding, owner, name);
    const names = new Set<string>();
    for (const tool of tools) {
      if (!tool.name || !tool.action || !tool.parameters || tool.parameters.type !== "object" || names.has(tool.name)) throw new Error("Invalid hosted tool descriptor");
      names.add(tool.name);
      for (const [other, descriptors] of this.descriptors) if (other !== pluginId && descriptors.some(item => item.name === tool.name)) throw new Error(`Hosted tool ownership conflict: ${tool.name}`);
      for (const binding of this.bindings) if (binding.compatible !== false) this.assertOwner(binding, pluginId, tool.name);
    }
  }
  private assertOwner(binding: Binding, pluginId: string, name: string): void {
    const owner = binding.owned.get(name);
    if (owner && owner !== pluginId) throw new Error(`Hosted tool ownership conflict: ${name}`);
    const current = binding.pi.getAllTools().find(tool => tool.name === name);
    if (current && (!owner || current.parameters !== binding.definitions.get(name)?.parameters)) throw new Error(`Tool already belongs to another extension or builtin: ${name}`);
  }
  private publish(binding: Binding): void {
    if (!this.sdkContract) { void this.verifyCompatibility(); return; }
    if (!this.sdkContract.supported) { binding.compatible = false; binding.missing = this.sdkContract.missing; return; }
    if (binding.compatible === undefined) {
      const assessment = assessHostedSdk(binding.pi);
      binding.compatible = assessment.supported; binding.missing = assessment.missing;
    }
    if (!binding.compatible) return;
    // Preflight every name (including removals) before modifying any registry entry.
    for (const [name, owner] of binding.owned) this.assertOwner(binding, owner, name);
    for (const [id, tools] of this.descriptors) for (const tool of tools) this.assertOwner(binding, id, tool.name);
    const live = new Set<string>();
    for (const [id, tools] of this.descriptors) for (const tool of tools) {
      binding.owned.set(tool.name, id);
      if (!this.allowed(binding, id, tool)) continue;
      live.add(tool.name);
      const policy = this.service.policy(id, binding.scope);
      const requested = policy.exposure ?? "direct";
      // model-only makes nested denial an SDK registry property as well as an
      // event guard. Missing parent metadata cannot silently grant nested use.
      const exposure: ToolExposure = !policy.allowNested && requested === "direct" ? "model-only" : requested;
      const definition: ToolDefinition = {
        name: tool.name, label: tool.label, description: tool.description,
        parameters: structuredClone(tool.parameters) as ToolDefinition["parameters"], exposure,
        execute: async (_toolCallId, input, signal) => {
          if (!this.allowed(binding, id, tool)) throw new Error("Hosted tool denied by host policy");
          // Provider call IDs are opaque (e.g. call_…|fc_…), not host lease IDs.
          // A fresh invocation ID also isolates reused call IDs across sessions/turns.
          return this.service.invoke(id, { requestId: randomUUID(), scope: { ...binding.scope }, kind: "tool", action: tool.action, input }, signal);
        },
      };
      binding.pi.registerTool(definition); binding.definitions.set(tool.name, definition);
    }
    for (const name of binding.owned.keys()) if (!live.has(name)) {
      // No old schema, worker closure, action, renderer or plugin object survives hiding.
      const tombstone: ToolDefinition = { name, label: name, description: "Unavailable host tool", parameters: { type: "object", properties: {} } as ToolDefinition["parameters"], exposure: "hidden", execute: unavailable };
      binding.pi.registerTool(tombstone); binding.definitions.set(name, tombstone);
    }
    // SDK refresh preserves prior active names even when direct -> codemode.
    // Never let an old declaration silently defeat a host exposure change.
    binding.pi.setActiveTools(binding.pi.getActiveTools().filter(name => {
      const definition = binding.definitions.get(name);
      return !definition || definition.exposure === "direct" || definition.exposure === "model-only";
    }));
  }
  /** UI actions share policy and admission. Explicit action allowlisting belongs to the service. */
  async invokeAction(pluginId: string, scope: HostedScope, action: string, input: unknown, signal?: AbortSignal): ReturnType<ToolDefinition["execute"]> {
    this.assertAdmission();
    if (this.sdkContract?.supported !== true) throw new Error("Hosted SDK capabilities are unavailable for this session");
    if ([...this.bindings].some(binding => binding.scope.sessionId === scope.sessionId && binding.compatible === false)) throw new Error("Hosted SDK capabilities are unavailable for this session");
    const policy = this.service.policy(pluginId, scope);
    if (!policy.enabled || policy.planMode || policy.allowlist) throw new Error("Hosted action denied by host policy");
    return this.service.invoke(pluginId, { requestId: randomUUID(), scope, kind: "action", action, input }, signal);
  }
}
async function unavailable(): ReturnType<ToolDefinition["execute"]> { throw new Error("Hosted tool unavailable"); }
