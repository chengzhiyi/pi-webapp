import type { WebPluginCatalogView } from "../../../contracts/bridge-contract.ts";
import type { PluginManagementView } from "../../../contracts/plugins.ts";
import type { PluginRequestContext, ServerPlugin } from "./server-plugin.ts";
import { PluginManagementError, PluginPreferences } from "./preferences.ts";

/** One registration path owns builtin request dispatch, enablement and resource teardown. */
export class ServerPluginRegistry {
  readonly routes: string[];
  private readonly running = new Map<string, number>();
  private changing = false;
  readonly plugins: readonly ServerPlugin[];
  readonly preferences: PluginPreferences;
  constructor(plugins: readonly ServerPlugin[], preferences: PluginPreferences) {
    this.plugins = plugins;
    this.preferences = preferences;
    this.routes = plugins.flatMap(plugin => [...plugin.routes]);
    if (new Set(plugins.map(plugin => plugin.metadata.id)).size !== plugins.length || new Set(this.routes).size !== this.routes.length) throw new Error("Duplicate server plugin registration");
  }
  get mutating() { return this.changing; }
  actionRoute(id: string, action: string) { return this.plugins.find(plugin => plugin.metadata.id === id)?.routes.find(route => route.split("/").at(-1) === action && !route.endsWith("/attach")); }
  private external(external: WebPluginCatalogView) {
    const ids = new Set(this.plugins.map(plugin => plugin.metadata.id));
    return { plugins: external.plugins.filter(plugin => !ids.has(plugin.id)), errors: [...external.errors, ...external.plugins.filter(plugin => ids.has(plugin.id)).map(plugin => `Plugin ID reserved by host: ${plugin.id}`)] };
  }
  catalog(input: WebPluginCatalogView): WebPluginCatalogView {
    const external = this.external(input);
    return { ...external, plugins: [
      ...this.plugins.filter(plugin => this.preferences.enabled(plugin.metadata.id)).map(plugin => ({ id: plugin.metadata.id, client: `builtin:${plugin.metadata.id}` })),
      ...external.plugins,
    ] };
  }
  inventory(external: WebPluginCatalogView): PluginManagementView {
    return { revision: this.preferences.revision(), scope: "global", items: [
      ...this.plugins.map(plugin => ({ ...plugin.metadata, enabled: this.preferences.enabled(plugin.metadata.id), managed: true })),
      ...this.external(external).plugins.map(plugin => ({ id: plugin.id, name: plugin.id, description: { zh: "由 Pi 软件包提供的 Web 插件。请在包与扩展中管理其运行时。", en: "Web plugin supplied by a Pi package. Manage its runtime under Packages & extensions." }, version: "", kind: "external" as const, enabled: true, managed: false, reason: "pi-runtime-owned" })),
    ] };
  }
  async toggle(id: string, enabled: boolean, expected: string, guard: () => void) {
    if (!this.plugins.some(plugin => plugin.metadata.id === id)) throw new PluginManagementError("此插件需要通过 Pi 软件包管理", 400);
    if (this.changing || [...this.running.values()].some(count => count > 0)) throw new PluginManagementError("插件操作正在进行，请等待完成");
    this.changing = true;
    try {
      await this.preferences.set(id, enabled, expected, guard);
      if (!enabled) await this.plugins.find(plugin => plugin.metadata.id === id)?.disable?.();
    } finally { this.changing = false; }
  }
  async dispatch(context: PluginRequestContext): Promise<boolean> {
    const plugin = this.plugins.find(plugin => plugin.routes.includes(context.path));
    if (!plugin) return false;
    if (this.changing) { context.json(409, { error: "插件配置正在保存，请稍后重试" }); return true; }
    if (!this.preferences.enabled(plugin.metadata.id)) { context.json(403, { error: "插件已停用", errorCode: "plugin_disabled" }); return true; }
    const id = plugin.metadata.id;
    this.running.set(id, (this.running.get(id) ?? 0) + 1);
    try { await plugin.handle(context); }
    finally { this.running.set(id, this.running.get(id)! - 1); }
    return true;
  }
  async runAgentAction(id: string, cwd: string, sessionId: string, action: string, input: unknown): Promise<unknown> {
    const plugin = this.plugins.find(p => p.metadata.id === id);
    if (!plugin?.agentAction || !this.preferences.enabled(id)) throw new PluginManagementError("绘图插件不可用或已停用", 403);
    if (this.changing) throw new PluginManagementError("插件配置正在保存，请稍后重试");
    this.running.set(id, (this.running.get(id) ?? 0) + 1);
    try { return await plugin.agentAction(cwd, sessionId, action, input); }
    finally { this.running.set(id, this.running.get(id)! - 1); }
  }
  async coordinateStart<T>(cwd: string, operation: () => Promise<T>): Promise<T> {
    if (this.changing) throw new PluginManagementError("插件配置正在保存，请稍后重试");
    const key = "@host/start";
    this.running.set(key, (this.running.get(key) ?? 0) + 1);
    let run = operation;
    for (const plugin of this.plugins) if (plugin.coordinateStart && this.preferences.enabled(plugin.metadata.id)) {
      const next = run;
      run = () => plugin.coordinateStart!(cwd, next);
    }
    try { return await run(); }
    finally { this.running.set(key, this.running.get(key)! - 1); }
  }
  requestFailure(error: unknown) {
    if (error instanceof PluginManagementError) return { status: error.status, body: { error: error.message, errorCode: "validation_error", reason: "plugin_busy" } };
    for (const plugin of this.plugins) { const failure = plugin.requestFailure?.(error); if (failure) return failure; }
    return null;
  }
  restartBlocker() {
    if (this.changing || [...this.running.values()].some(count => count > 0)) return "插件操作正在进行，请完成后再升级";
    return this.plugins.map(plugin => plugin.restartBlocker?.()).find(Boolean) ?? null;
  }
  async close() { await Promise.all(this.plugins.map(plugin => plugin.close?.())); }
}
