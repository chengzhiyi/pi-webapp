import * as React from "react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { WebSlotName, WebSlotProps } from "@chengzhiyi/pi-web-protocol";
import type { SessionView, WebPluginCatalogView, ViewBlock, ViewMessage } from "../../contracts/bridge-contract.ts";
import { WebPluginRuntime, type LoadedPlugin } from "./plugin-manager.ts";
import { loadBuiltinPlugin } from "../../plugins/builtin/client.ts";
export type { LoadedPlugin } from "./plugin-manager.ts";

function loadStyle(url: string, signal: AbortSignal): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet"; link.href = url;
    const remove = () => { signal.removeEventListener("abort", abort); link.onload = link.onerror = null; link.remove(); };
    const abort = () => { remove(); reject(new Error("Plugin stylesheet aborted")); };
    signal.addEventListener("abort", abort, { once: true });
    link.onload = () => { signal.removeEventListener("abort", abort); link.onload = link.onerror = null; resolve(remove); };
    link.onerror = () => { remove(); reject(new Error("Plugin stylesheet failed to load")); };
    if (signal.aborted) abort(); else document.head.append(link);
  });
}

export function useWebPlugins(connected: boolean, sessionId: string | undefined, getCatalog: () => Promise<WebPluginCatalogView>, generation = 0) {
  const [runtime] = useState(() => new WebPluginRuntime({
    loadModule: url => url.startsWith("builtin:") ? loadBuiltinPlugin(url) : import(/* @vite-ignore */ url), loadStyle,
  }));
  const snapshot = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  const retained = useRef(new Map<string, LoadedPlugin[]>());
  if (snapshot.sessionId && snapshot.ready) retained.current.set(snapshot.sessionId, snapshot.plugins.filter(plugin => plugin.definition.workbench));
  useEffect(() => {
    if (!connected || !sessionId) return;
    (globalThis as typeof globalThis & { __PI_WEBAPP_REACT__?: typeof React }).__PI_WEBAPP_REACT__ = React;
    void runtime.start(sessionId, getCatalog);
    return () => runtime.dispose();
  }, [runtime, connected, sessionId, generation]);
  const current = connected && snapshot.sessionId === sessionId;
  // Builtin panel definitions remain renderable while offline; activation resources are still disposed.
  return { plugins: current ? snapshot.plugins : !connected && sessionId ? retained.current.get(sessionId) ?? [] : [], errors: current ? snapshot.errors : [] };
}

export class PluginBoundary extends React.Component<{ children: React.ReactNode; id: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error) { console.error(`pi-webapp plugin ${this.props.id}:`, error); }
  render() { return this.state.failed ? null : this.props.children; }
}

export type PluginHostProps = Omit<WebSlotProps, "invokeAction" | "resolveInteraction" | "session"> & {
  session: SessionView | null;
  invokePluginAction: (pluginId: string, action: string, input?: unknown) => Promise<unknown>;
  resolvePluginInteraction: (pluginId: string, requestId: string, value: unknown) => Promise<void>;
};
function boundProps(props: PluginHostProps, pluginId: string): WebSlotProps {
  return { ...props,
    invokeAction: <T,>(action: string, input?: unknown) => props.invokePluginAction(pluginId, action, input) as Promise<T>,
    resolveInteraction: (value) => {
      if (!props.interaction || props.interaction.pluginId !== pluginId) return Promise.reject(new Error("No pending interaction"));
      return props.resolvePluginInteraction(pluginId, props.interaction.requestId, value);
    },
  };
}
export function PluginInteraction({ plugins, props }: { plugins: readonly LoadedPlugin[]; props: PluginHostProps }) {
  const interaction = props.session?.interactions?.find((request) => plugins.some((plugin) => plugin.id === request.pluginId && plugin.definition.interactions?.some((item) => item.kind === request.kind)));
  const plugin = plugins.find((item) => item.id === interaction?.pluginId);
  const Component = plugin?.definition.interactions?.find((item) => item.kind === interaction?.kind)?.component;
  if (!interaction || !plugin || !Component) return null;
  return <PluginBoundary key={`${plugin.instanceId ?? plugin.id}/${interaction.requestId}`} id={plugin.id}><Component {...boundProps({ ...props, interaction }, plugin.id)} /></PluginBoundary>;
}
export function PluginToolView({ plugins, props, call, result, running }: { plugins: readonly LoadedPlugin[]; props: PluginHostProps; call: ViewBlock; result?: ViewMessage; running: boolean }) {
  const owner = plugins.flatMap(plugin => (plugin.definition.workbench?.toolViews ?? []).map(view => ({ plugin, view }))).find(({ view }) => view.tools.includes(call.toolName ?? ""));
  if (!owner) return null;
  const Component = owner.view.component;
  return <PluginBoundary id={owner.plugin.id}><Component {...boundProps(props, owner.plugin.id)} call={call} result={result} running={running} /></PluginBoundary>;
}
export function PluginSlot({ plugins, slot, props }: { plugins: readonly LoadedPlugin[]; slot: WebSlotName; props: PluginHostProps }) {
  const contributions = plugins.flatMap((plugin) => (plugin.definition.slots ?? []).filter((item) => item.slot === slot).map((item) => ({ plugin, item })));
  contributions.sort((a, b) => (a.item.order ?? 0) - (b.item.order ?? 0) || a.plugin.id.localeCompare(b.plugin.id) || a.item.id.localeCompare(b.item.id));
  return <>{contributions.map(({ plugin, item }) => {
    const Component = item.component;
    return <PluginBoundary key={`${plugin.instanceId ?? plugin.id}/${item.id}`} id={plugin.id}><Component {...boundProps(props, plugin.id)} /></PluginBoundary>;
  })}</>;
}
