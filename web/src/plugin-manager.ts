import { isWebCommandContribution } from "@chengzhiyi/pi-web-protocol";
import type { WebPluginDefinition, WebPluginLifecycleContext } from "@chengzhiyi/pi-web-protocol";
import type { WebPluginCatalogView } from "../../extension/web-plugins.ts";

export interface LoadedPlugin { id: string; definition: WebPluginDefinition; instanceId?: string }
export interface PluginRuntimeSnapshot { sessionId: string | null; generation: number; plugins: LoadedPlugin[]; errors: string[] }
export interface PluginEnvironment {
  loadModule(url: string): Promise<unknown>;
  loadStyle(url: string, signal: AbortSignal): Promise<() => void>;
  report?(message: string): void;
  loadTimeoutMs?: number;
}

function validateDefinition(value: unknown, expectedId: string): WebPluginDefinition {
  if (!value || typeof value !== "object") throw new Error("Module must default export a plugin definition");
  const definition = value as WebPluginDefinition;
  if (definition.id !== expectedId || definition.apiVersion !== 1) throw new Error("Plugin id or apiVersion does not match the catalog");
  if (typeof definition.activate !== "function") throw new Error("Plugin must declare synchronous activate(context)");
  for (const key of ["slots", "commands", "menuItems", "interactions", "artifactTools"] as const) {
    if (definition[key] !== undefined && !Array.isArray(definition[key])) throw new Error(`${key} must be an array`);
  }
  const ids = new Set<string>();
  for (const slot of definition.slots ?? []) {
    if (!slot || !["composer.controls", "turn.tail", "rightbar.panel", "rightbar.title"].includes(slot.slot) || typeof slot.id !== "string" || typeof slot.component !== "function" || ids.has(slot.id)) throw new Error("Invalid or duplicate slot");
    ids.add(slot.id);
  }
  for (const item of [...(definition.commands ?? []), ...(definition.menuItems ?? [])]) {
    if (!item || typeof item.id !== "string" || typeof item.action !== "string" || ids.has(item.id)) throw new Error("Invalid or duplicate command/menu contribution");
    ids.add(item.id);
  }
  if ((definition.commands ?? []).some(command => !isWebCommandContribution(command))) throw new Error("Invalid command");
  const kinds = new Set<string>();
  for (const item of definition.interactions ?? []) {
    if (!item || typeof item.kind !== "string" || !item.kind || kinds.has(item.kind) || typeof item.component !== "function") throw new Error("Invalid or duplicate interaction");
    kinds.add(item.kind);
  }
  if (definition.composerPlaceholder !== undefined && typeof definition.composerPlaceholder !== "function") throw new Error("Invalid composer placeholder");
  if (definition.composerAction !== undefined && typeof definition.composerAction !== "function") throw new Error("Invalid composer action");
  if (definition.artifactTools?.some(name => typeof name !== "string")) throw new Error("Invalid artifact tools");
  return definition;
}

function waitFor<T>(work: Promise<T>, signal: AbortSignal, timeoutMs?: number): Promise<T> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => finish(new Error("Plugin load aborted"));
    const finish = (error: Error | null, value?: T) => {
      clearTimeout(timer); signal.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(value as T);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (timeoutMs !== undefined) timer = setTimeout(() => finish(new Error("Plugin load timed out")), timeoutMs);
    work.then(value => finish(null, value), error => finish(error));
    if (signal.aborted) abort();
  });
}

class ActivationScope {
  readonly controller = new AbortController();
  private cleanups: Array<() => void> = [];
  private disposed = false;
  private readonly report: (error: unknown) => void;
  constructor(report: (error: unknown) => void) { this.report = report; }
  context(sessionId: string): WebPluginLifecycleContext {
    return { sessionId, signal: this.controller.signal, onDispose: cleanup => {
      if (typeof cleanup !== "function") throw new Error("onDispose expects a cleanup function");
      if (this.disposed) this.clean(cleanup); else this.cleanups.push(cleanup);
    } };
  }
  private clean(cleanup: () => void) { try { cleanup(); } catch (error) { this.report(error); } }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.controller.abort();
    for (const cleanup of this.cleanups.splice(0).reverse()) this.clean(cleanup);
  }
}

interface RuntimeRun { sessionId: string; generation: number; controller: AbortController; scopes: ActivationScope[] }
const empty = (generation: number, sessionId: string | null = null): PluginRuntimeSnapshot => ({ sessionId, generation, plugins: [], errors: [] });

/** Module definitions can be cached; activated resources always belong to one run. */
export class WebPluginRuntime {
  private readonly environment: PluginEnvironment;
  private run: RuntimeRun | null = null;
  private snapshot = empty(0);
  private generation = 0;
  private listeners = new Set<() => void>();
  constructor(environment: PluginEnvironment) { this.environment = environment; }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(snapshot: PluginRuntimeSnapshot) { this.snapshot = snapshot; for (const listener of this.listeners) listener(); }
  private error(run: RuntimeRun, pluginId: string, stage: string, error: unknown) {
    const message = `plugin=${pluginId} session=${run.sessionId} generation=${run.generation} stage=${stage}: ${error instanceof Error ? error.message : String(error)}`;
    (this.environment.report ?? console.error)(message);
    if (this.run === run) this.update({ ...this.snapshot, errors: [...this.snapshot.errors, message] });
  }
  async start(sessionId: string, getCatalog: () => Promise<WebPluginCatalogView>): Promise<void> {
    this.dispose();
    const run: RuntimeRun = { sessionId, generation: ++this.generation, controller: new AbortController(), scopes: [] };
    this.run = run;
    this.update(empty(run.generation, sessionId));
    try {
      const catalog = await waitFor(Promise.resolve().then(getCatalog), run.controller.signal);
      if (this.run !== run) return;
      for (const message of catalog.errors) this.error(run, "catalog", "discover", message);
      for (const item of catalog.plugins) {
        if (this.run !== run) break;
        const scope = new ActivationScope(error => this.error(run, item.id, "dispose", error));
        run.scopes.push(scope);
        const context = scope.context(sessionId);
        let stage = "load";
        try {
          const module = await waitFor(this.environment.loadModule(item.client), run.controller.signal, this.environment.loadTimeoutMs ?? 10_000);
          if (this.run !== run) break;
          stage = "validate";
          const definition = validateDefinition((module as { default?: unknown } | null)?.default, item.id);
          if (item.style) {
            stage = "style";
            await waitFor(this.environment.loadStyle(item.style, context.signal).then(cleanup => { context.onDispose(cleanup); }), run.controller.signal, this.environment.loadTimeoutMs ?? 10_000);
          }
          if (this.run !== run) break;
          stage = "activate";
          const result: unknown = definition.activate(context);
          if (result !== undefined) {
            // Reject async activation without leaving an unhandled rejection.
            void Promise.resolve(result).catch(error => this.error(run, item.id, "activate", error));
            throw new Error("activate must be synchronous and return void");
          }
          if (this.run !== run) { scope.dispose(); break; }
          this.update({ ...this.snapshot, plugins: [...this.snapshot.plugins, { id: item.id, definition, instanceId: `${run.generation}/${item.id}` }] });
        } catch (error) {
          if (this.run === run) this.error(run, item.id, stage, error);
          scope.dispose();
        }
      }
    } catch (error) { if (this.run === run) this.error(run, "catalog", "discover", error); }
  }
  dispose() {
    const run = this.run;
    if (!run) return;
    this.run = null;
    run.controller.abort();
    for (const scope of run.scopes.reverse()) scope.dispose();
    this.update(empty(this.generation));
  }
}
