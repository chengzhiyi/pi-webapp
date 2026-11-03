import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LoadedPlugin } from "../plugin-manager.ts";
import type { WorkbenchPanelProps, ToolViewProps } from "../../../contracts/workbench.ts";
import type { HostedExecuteApproval, HostedMount, HostedPluginCard, HostedViewIdentity } from "../../../contracts/hosted-plugins.ts";
import { hostedApi } from "./api.ts";
import { retainHostedCards } from "./catalog.ts";
import { FrameAdapter, hostedFrames } from "./frame-adapter.ts";
import { useHostedReconciliation } from "./reconciliation.tsx";
import { HostedViewClient } from "./view-client.ts";
import { downloadDrawing } from "./download.ts";
import { HostedToolCard } from "./ToolCard.tsx";
import { notification, toolHeight, toolPresentation } from "./tool-ui.ts";
import { HostedPluginIcon } from "./PluginIcon.tsx";
import { dismissToast, showToast } from "../../../../web/src/ui/primitives/Toast.tsx";

// A host outage fails a plugin's controller, panels and tool cards together, so
// failed frames of one plugin share one app toast; Reconnect retries all of them.
const failedViews = new Map<string, Map<object, () => void>>();
function viewFailed(card: HostedPluginCard, owner: object, locale: "zh" | "en", cause: unknown, retry: () => void) {
  const views = failedViews.get(card.pluginId) ?? new Map<object, () => void>();
  failedViews.set(card.pluginId, views); views.set(owner, retry);
  const zh = locale === "zh";
  showToast({ key: `hosted-view:${card.pluginId}`, message: zh ? `${card.name} 连接中断` : `${card.name} lost its connection`,
    detail: cause instanceof Error ? cause.message : String(cause), detailLabel: zh ? "诊断信息" : "Diagnostics",
    action: { label: zh ? "重新连接" : "Reconnect", onClick: () => { const pending = [...views.values()]; views.clear(); for (const run of pending) run(); } } });
}
function viewRecovered(pluginId: string, owner: object) {
  const views = failedViews.get(pluginId);
  if (views?.delete(owner) && !views.size) dismissToast(`hosted-view:${pluginId}`);
}

interface HostedCallbacks { current: { openPanel?(alias: string): void; sendMessage?(text: string): Promise<void>; abort?(): Promise<void> } }

function HostedFrame({ card, mount, update, open, sendMessage, reconnect, abort }: {
  card: HostedPluginCard; mount: HostedMount; update?: unknown;
  open(kind: string, id: string, title: string): void; sendMessage(text: string): Promise<void>; reconnect(): void; abort?(): Promise<void>;
}) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const adapter = useRef<FrameAdapter | null>(null);
  const viewClient = useRef<HostedViewClient | null>(null);
  const ready = useRef<Promise<unknown>>(Promise.resolve());
  const callbacks = useRef({ open, sendMessage, reconnect, abort }); callbacks.current = { open, sendMessage, reconnect, abort };
  const owner = useRef({}).current;
  const mounted = useRef(false);
  const [attempt, setAttempt] = useState(0);
  const fail = useRef((_cause: unknown) => {});
  const retry = useRef(() => {});
  fail.current = cause => viewFailed(card, owner, mount.locale, cause, () => retry.current());
  retry.current = () => {
    // A frame that never finished mounting has nothing to resume: mount it again.
    if (!mounted.current) { setAttempt(value => value + 1); return; }
    try { viewClient.current?.retry(); } catch (cause) { fail.current(cause); }
  };
  useEffect(() => () => viewRecovered(card.pluginId, owner), [card.pluginId, owner]);
  const [presentation, setPresentation] = useState<{ title: string }>();
  const [height, setHeight] = useState(240); // Compatibility fallback for unnegotiated frames.
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
    mounted.current = false;
    const report = (cause: unknown) => { if (alive) fail.current(cause); };
    let client: HostedViewClient;
    const frame = new FrameAdapter(iframe.current, identity, async (method, input) => {
      if (!alive) throw new Error("Frame mount cancelled");
      const value = input as Record<string, unknown>;
      if (method === "toolPresentation" && mount.kind === "tool") { setPresentation(toolPresentation(input)); return null; }
      if (method === "resize" && mount.kind === "tool") { setHeight(toolHeight(input)); return null; }
      if (method === "notify") { const notice = notification(input); showToast({ tone: notice.level, message: notice.message }); return null; }
      if (method === "action") {
        if (typeof value?.action !== "string") throw new Error("Invalid action");
        return hostedApi.action({ sessionId: identity.sessionId, pluginId: identity.pluginId, generation: identity.generation, ...client.capability, action: value.action, input: value.input });
      }
      if (method === "downloadDrawing" && ["editor", "workspace"].includes(mount.kind)) { downloadDrawing(input); return null; }
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
    adapter.current = frame; viewClient.current = client;
    const work = (async () => {
      await client.start();
      if (!alive) throw new Error("Frame mount cancelled");
      client.connecting();
      await frame.connect((mount.kind === "controller" ? card.controllerUrl : card.documentUrl)!, { ...mount, theme: theme(), hostUi: { toolCard: true, autoResize: true, notifications: true } });
      client.listen();
      mounted.current = true;
      viewRecovered(card.pluginId, owner);
    })();
    ready.current = work;
    const remove = hostedFrames.add({ identity, ready: work, adapter: frame, afterFlush: () => client.flushed(), toolCallId: (update as ToolViewProps | undefined)?.call?.toolCallId, retire: () => client.close() });
    void work.catch(report);
    return () => {
      alive = false; remove(); adapter.current = null; viewClient.current = null;
      // Navigation/tab closure preflushes through FrameRegistry; generation changes freeze first.
      // React has removed/replaced the iframe here, so its realm/pagehide owns remote cleanup.
      // Do not issue a dispose RPC into a destroyed realm and retain a doomed timeout/port.
      void work.catch(() => {}).then(() => client.close()).catch(cause => console.error("Hosted view cleanup did not acknowledge edits", cause)).finally(() => frame.dispose());
    };
  }, [card.pluginId, card.generation, card.documentUrl, card.controllerUrl, mount.sessionId, mount.kind, mount.contentId, attempt]);
  useEffect(() => {
    void ready.current.then(() => {
      const target = adapter.current;
      // A generation switch freezes and later disposes the old frame, rejecting its pending
      // update after the new frame has recovered. Only the live frame's failures count.
      return target?.call("update", { ...mount, ...(update as object ?? {}), theme: currentTheme }).catch(cause => { if (adapter.current === target) fail.current(cause); });
    }, () => { /* The mount effect already reported its own failure. */ });
  }, [update, mount.locale, currentTheme, mount.visible, mount.title]);
  // Failures and notices go to the app toast stack, never inline: the controller is
  // mounted outside the layout, and its retry must stay reachable because it shares
  // the generation barrier with visible editors.
  const content = <div data-hosted-plugin={card.pluginId} style={{ height: mount.kind === "controller" || mount.kind === "tool" ? "auto" : "100%", minHeight: 0 }}>
    <iframe hidden={mount.kind === "controller"} ref={iframe} title={`${card.name} ${mount.kind}`} style={{ display: mount.kind === "controller" ? "none" : "block", width: "100%", height: mount.kind === "tool" ? height : "100%", border: 0 }} />
  </div>;
  return mount.kind === "tool" ? <HostedToolCard title={presentation?.title} tool={update as ToolViewProps} locale={mount.locale}>{content}</HostedToolCard> : content;
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
      entry: { ...contribution.entry, kind: panelKind(contribution.entry.kind), icon: props => <HostedPluginIcon card={card} {...props} /> },
      panels: contribution.panels.map(kind => ({ kind: panelKind(kind), component: (props: WorkbenchPanelProps) => <HostedFrame card={card} reconnect={reconnect} abort={() => callbacks.current.abort?.() ?? Promise.reject(new Error("Abort unavailable"))}
        mount={{ kind: kind === contribution.entry.kind ? "workspace" : "editor", sessionId: props.session.sessionId, contentId: props.contentId, title: props.title, visible: props.visible, locale: props.locale, theme: theme() }} open={(kind, id, title) => props.open(panelKind(kind), id, title)} sendMessage={props.sendMessage} /> })),
      toolViews: contribution.toolViews.length ? [{ tools: contribution.toolViews, component: (props: ToolViewProps) => props.session ? <HostedFrame key={hostedFrames.incarnation(props.session.sessionId, props.call.toolCallId)} card={card} reconnect={reconnect} abort={() => callbacks.current.abort?.() ?? Promise.reject(new Error("Abort unavailable"))}
        mount={{ kind: "tool", sessionId: props.session.sessionId, locale: props.locale, theme: theme() }} update={{ call: props.call, result: props.result, running: props.running }}
        open={(kind, id) => props.openPanel(`${contribution.panelAlias.prefix}${id}`)} sendMessage={props.sendMessage} /> : null }] : [],
      resolvePanel: id => id.startsWith(contribution.panelAlias.prefix) ? { kind: panelKind(contribution.panelAlias.kind), contentId: id.slice(contribution.panelAlias.prefix.length), title: contribution.panelAlias.title } : null,
    },
  } };
}
/** The v1 runtime is untouched. Hosted frames are adapted into existing workbench rendering slots. */
export function useHostedPlugins(connected: boolean, sessionId: string | undefined, generation: number, callbacks: HostedCallbacks, locale: "zh" | "en") {
  const recovery = useHostedReconciliation({ sessionId, locale, openRecovered: contentId => callbacks.current.openPanel?.(`diagram:${contentId}`) });
  const [cards, setCards] = useState<HostedPluginCard[]>([]);
  const [approvals, setApprovals] = useState<HostedExecuteApproval[]>([]);
  const [inactivePlugins, setInactivePlugins] = useState<string[]>([]);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const reconnect = useMemo(() => () => setRevision(value => value + 1), []);
  useEffect(() => {
    if (!connected || !sessionId) { setCards([]); return; }
    let alive = true; const abort = new AbortController();
    window.addEventListener("pi:hosted-catalog-changed", reconnect);
    void hostedApi.catalog(abort.signal).then(catalog => { if (alive) {
      setCards(previous => retainHostedCards(catalog.plugins, previous));
      setApprovals(catalog.approvals ?? []);
      // Only authoritative disabled/uninstalled state retires owned tabs. Pending
      // updates and failed reads must leave the mounted editor and undo intact.
      if (!catalog.offline) setInactivePlugins(catalog.plugins.filter(card => !card.installed || !card.enabled).map(card => card.pluginId));
      setError("");
    } }).catch(() => { /* Read failures are owned by the plugin management page; a global banner would only repeat them outside the layout. Previous cards stay mounted. */ });
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
  const decide = useCallback((id: string, decision: "allow" | "deny") => {
    void hostedApi.decide(id, decision).then(catalog => setApprovals(catalog.approvals ?? [])).catch(cause => setError(String(cause)));
  }, []);
  return { plugins: connected ? plugins : [], inactivePlugins, recovery, controllers, error, approvals, decide };
}
