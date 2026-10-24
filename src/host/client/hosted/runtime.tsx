import { useEffect, useMemo, useRef, useState } from "react";
import type { LoadedPlugin } from "../plugin-manager.ts";
import type { WorkbenchPanelProps, ToolViewProps } from "../../../contracts/workbench.ts";
import type { HostedMount, HostedPluginCard, HostedViewIdentity } from "../../../contracts/hosted-plugins.ts";
import { hostedApi } from "./api.ts";
import { retainHostedCards } from "./catalog.ts";
import { FrameAdapter, hostedFrames } from "./frame-adapter.ts";
import { HostedViewClient } from "./view-client.ts";

interface HostedCallbacks { current: { openPanel?(alias: string): void; sendMessage?(text: string): Promise<void>; abort?(): Promise<void> } }

function HostedFrame({ card, mount, update, open, sendMessage, reconnect, abort }: {
  card: HostedPluginCard; mount: HostedMount; update?: unknown;
  open(kind: string, id: string, title: string): void; sendMessage(text: string): Promise<void>; reconnect(): void; abort?(): Promise<void>;
}) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const adapter = useRef<FrameAdapter | null>(null);
  const ready = useRef<Promise<unknown>>(Promise.resolve());
  const callbacks = useRef({ open, sendMessage, reconnect, abort }); callbacks.current = { open, sendMessage, reconnect, abort };
  const [error, setError] = useState("");
  const [currentTheme, setTheme] = useState(theme);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(theme()));
    observer.observe(document.body, { attributes: true, attributeFilter: ["data-ds-dark-theme"] });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!iframe.current || card.generation === undefined) return;
    const identity: HostedViewIdentity = { pluginId: card.pluginId, generation: card.generation, sessionId: mount.sessionId, mountId: crypto.randomUUID() };
    let alive = true;
    const report = (cause: unknown) => { if (alive) setError(cause instanceof Error ? cause.message : String(cause)); };
    let client: HostedViewClient;
    const frame = new FrameAdapter(iframe.current, identity, async (method, input) => {
      const value = input as Record<string, unknown>;
      if (method === "action") {
        if (typeof value?.action !== "string") throw new Error("Invalid action");
        return hostedApi.action({ sessionId: identity.sessionId, pluginId: identity.pluginId, generation: identity.generation, ...client.capability, action: value.action, input: value.input });
      }
      if (method === "changed") return client.changed(input);
      if (method === "abort" && callbacks.current.abort) { await callbacks.current.abort(); return null; }
      if (method === "openPanel") {
        if (typeof value?.kind !== "string" || !card.contribution?.panels.includes(value.kind) || typeof value.contentId !== "string") throw new Error("Undeclared panel");
        callbacks.current.open(value.kind, value.contentId, typeof value.title === "string" ? value.title : card.name); return null;
      }
      if (method === "sendMessage" && typeof value?.text === "string") { await callbacks.current.sendMessage(value.text); return null; }
      throw new Error(`Unsupported frame host method: ${method}`);
    });
    client = new HostedViewClient(identity, frame, mount, () => callbacks.current.reconnect(), report);
    adapter.current = frame;
    const work = (async () => {
      await client.start();
      if (!alive) throw new Error("Frame mount cancelled");
      client.connecting();
      await frame.connect((mount.kind === "controller" ? card.controllerUrl : card.documentUrl)!, { ...mount, theme: theme() });
      client.listen();
    })();
    ready.current = work;
    const remove = hostedFrames.add({ identity, ready: work, adapter: frame, afterFlush: () => client.flushed() });
    void work.catch(report);
    return () => {
      alive = false; remove(); adapter.current = null;
      // Keep the port alive for the final checkpoint; missing acknowledgements retain a server blocker.
      void work.catch(() => {}).then(async () => { await client.close(); await frame.call("dispose"); }).catch(cause => console.error("Hosted view cleanup did not acknowledge edits", cause)).finally(() => frame.dispose());
    };
  }, [card.pluginId, card.generation, card.documentUrl, card.controllerUrl, mount.sessionId, mount.kind, mount.contentId]);
  useEffect(() => { void ready.current.then(() => adapter.current?.call("update", { ...mount, ...(update as object ?? {}), theme: currentTheme })).catch(cause => setError(String(cause))); }, [update, mount.locale, currentTheme, mount.visible, mount.title]);
  return <div hidden={mount.kind === "controller"} data-hosted-plugin={card.pluginId} style={{ height: mount.kind === "tool" ? 240 : "100%", minHeight: 0 }}>
    {error && <p role="alert">{error}</p>}
    <iframe ref={iframe} title={`${card.name} ${mount.kind}`} style={{ width: "100%", height: "100%", border: 0 }} />
  </div>;
}
const theme = (): "light" | "dark" => document.body.hasAttribute("data-ds-dark-theme") ? "dark" : "light";

function definition(card: HostedPluginCard, reconnect: () => void, callbacks: HostedCallbacks): LoadedPlugin {
  const contribution = card.contribution!;
  const panelKind = (kind: string) => `hosted:${card.pluginId}:${kind}`;
  return { id: card.pluginId, instanceId: `${card.pluginId}/${card.generation}`, definition: {
    id: card.pluginId, apiVersion: 1, activate() {},
    artifactTools: contribution.artifactTools,
    workbench: {
      apiVersion: 1,
      entry: { ...contribution.entry, kind: panelKind(contribution.entry.kind), icon: () => <span aria-hidden="true">◇</span> },
      panels: contribution.panels.map(kind => ({ kind: panelKind(kind), component: (props: WorkbenchPanelProps) => <HostedFrame card={card} reconnect={reconnect} abort={() => callbacks.current.abort?.() ?? Promise.reject(new Error("Abort unavailable"))}
        mount={{ kind: kind === contribution.entry.kind ? "workspace" : "editor", sessionId: props.session.sessionId, contentId: props.contentId, title: props.title, visible: props.visible, locale: props.locale, theme: theme() }} open={(kind, id, title) => props.open(panelKind(kind), id, title)} sendMessage={props.sendMessage} /> })),
      toolViews: contribution.toolViews.length ? [{ tools: contribution.toolViews, component: (props: ToolViewProps) => props.session ? <HostedFrame card={card} reconnect={reconnect} abort={() => callbacks.current.abort?.() ?? Promise.reject(new Error("Abort unavailable"))}
        mount={{ kind: "tool", sessionId: props.session.sessionId, locale: props.locale, theme: theme() }} update={{ call: props.call, result: props.result, running: props.running }}
        open={(kind, id) => props.openPanel(`${contribution.panelAlias.prefix}${id}`)} sendMessage={props.sendMessage} /> : null }] : [],
      resolvePanel: id => id.startsWith(contribution.panelAlias.prefix) ? { kind: panelKind(contribution.panelAlias.kind), contentId: id.slice(contribution.panelAlias.prefix.length), title: contribution.panelAlias.title } : null,
    },
  } };
}
/** The v1 runtime is untouched. Hosted frames are adapted into existing workbench rendering slots. */
export function useHostedPlugins(connected: boolean, sessionId: string | undefined, generation: number, callbacks: HostedCallbacks, locale: "zh" | "en") {
  const [cards, setCards] = useState<HostedPluginCard[]>([]);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const reconnect = useMemo(() => () => setRevision(value => value + 1), []);
  useEffect(() => {
    if (!connected || !sessionId) { setCards([]); return; }
    let alive = true; const abort = new AbortController();
    window.addEventListener("pi:hosted-catalog-changed", reconnect);
    void hostedApi.catalog(abort.signal).then(catalog => { if (alive) { setCards(previous => retainHostedCards(catalog.plugins, previous)); setError(""); } }).catch(cause => { if (alive) { if (cause.status !== 404) setError(String(cause)); } });
    return () => { alive = false; abort.abort(); window.removeEventListener("pi:hosted-catalog-changed", reconnect); };
  }, [connected, sessionId, generation, revision]);
  const definitions = useRef(new WeakMap<HostedPluginCard, LoadedPlugin>());
  const plugins = useMemo(() => cards.map(card => {
    let loaded = definitions.current.get(card);
    if (!loaded) { loaded = definition(card, reconnect, callbacks); definitions.current.set(card, loaded); }
    return loaded;
  }), [cards, reconnect, callbacks]);
  const controllers = connected && sessionId ? cards.map(card => <HostedFrame key={`${sessionId}/${card.pluginId}/${card.generation}`} card={card} reconnect={reconnect}
    abort={() => callbacks.current.abort?.() ?? Promise.reject(new Error("Abort unavailable"))} mount={{ kind: "controller", sessionId, locale, theme: theme() }} open={(_kind, id) => callbacks.current.openPanel?.(`${card.contribution!.panelAlias.prefix}${id}`)} sendMessage={async text => { if (!callbacks.current.sendMessage) throw new Error("Composer unavailable"); await callbacks.current.sendMessage(text); }} />) : null;
  return { plugins: connected ? plugins : [], controllers, error };
}
