import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { DockController, DockLayout, getPane, getTab, dockPaneIds, findTabPane, activeDockPaneId, type PaneId, type TabId } from "../../../web/src/ui/shared/dockkit/index.ts";
import { PanelChrome } from "../../../web/src/ui/shared/sidebar/PanelChrome.tsx";
import { dockLabels } from "../../../web/src/ui/shared/sidebar/labels.ts";
import { zh, en } from "../../../web/src/ui/shared/sidebar/locales.ts";
import { Button } from "../../../web/src/ui/shared/primitives/Button.tsx";
import { Tooltip } from "../../../web/src/ui/shared/primitives/Tooltip.tsx";
import { IconPanelLeftOutlineRegular } from "../../../web/src/ui/shared/primitives/icons/index.tsx";
import css from "../../../web/src/ui/shared/sidebar/SidebarRight.module.css";
import expandCss from "../../../web/src/ui/shared/sidebar/ExpandButton.module.css";
import { PluginBoundary, PluginSlot, type LoadedPlugin, type PluginHostProps } from "./plugin-runtime.tsx";
import { localize } from "../../../web/src/ui/locale/preference.ts";
import { randomUUID } from "./random-uuid.ts";
import type { TabResource, WorkbenchPanelProps } from "../../contracts/workbench.ts";
import filesCss from "../../../web/src/ui/workbench/WorkspacePanel.module.css";
import { hostedFrames } from "./hosted/frame-adapter.ts";

interface SessionDock { controller: DockController; resources: Map<string, TabResource>; owners: Map<string, string> }
/** Generic tab ownership: a capability supplies its model, cleanup and activation hooks. */
export function usePluginPanel(sessionId: string | undefined, disabledPlugins: readonly string[] = []) {
  const controllers = useRef(new Map<string, SessionDock>());
  const owned = useMemo(() => {
    const key = sessionId ?? "";
    let value = controllers.current.get(key);
    if (!value) {
      const guide = (id: TabId) => ({ id, kind: "guide", contentId: "guide", title: "开始" });
      value = { controller: new DockController({ makeInitialTab: guide, makePaneTab: guide }), resources: new Map(), owners: new Map() };
      const scope = value;
      scope.controller.subscribe(() => {
        const tabs = scope.controller.getSnapshot().state.tabs;
        for (const [id, resource] of scope.resources) if (!tabs[id as TabId]) { resource.dispose?.(); scope.resources.delete(id); }
        for (const id of scope.owners.keys()) if (!tabs[id as TabId]) scope.owners.delete(id);
      });
      controllers.current.set(key, value);
    }
    return value;
  }, [sessionId]);
  const { controller, resources, owners } = owned;
  useEffect(() => { for (const [id, scope] of controllers.current) for (const resource of scope.resources.values()) resource.activate?.(id === sessionId); }, [sessionId]);
  useEffect(() => {
    for (const scope of controllers.current.values()) for (const [tabId, pluginId] of [...scope.owners]) if (disabledPlugins.includes(pluginId)) scope.controller.closeTab(tabId as TabId);
  }, [disabledPlugins]);
  useEffect(() => () => { for (const scope of controllers.current.values()) for (const resource of scope.resources.values()) resource.dispose?.(); }, []);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const activeTab = getPane(snapshot.state, snapshot.state.activePaneId).activeTabId;
  const tab = activeTab ? getTab(snapshot.state, activeTab) : undefined;
  const panelId = tab?.kind === "plugin" ? tab.contentId : null;
  const expand = () => {
    if (!Object.keys(controller.getSnapshot().state.tabs).length) controller.openContent({ kind: "guide", contentId: "guide", title: "开始" });
    controller.setExpanded(true);
  };
  const openContent = useCallback((kind: string, contentId: string, title: string, paneId?: PaneId, pluginId?: string) => {
    const current = controller.getSnapshot().state;
    const target = paneId && getPane(current, paneId).host === "dock" ? paneId : activeDockPaneId(current);
    const pane = getPane(current, target);
    const guide = pane.activeTabId && current.tabs[pane.activeTabId]?.kind === "guide" ? pane.activeTabId : undefined;
    const existing = pane.tabs.find(id => current.tabs[id]?.kind === kind && current.tabs[id]?.contentId === contentId);
    const opened = existing ?? controller.openContent({ kind, contentId, title, paneId: target, revealIfOpened: kind !== "files" });
    if (pluginId) owners.set(opened, pluginId);
    if (existing) controller.focusTab(existing);
    if (guide) controller.closeTab(guide);
    controller.setExpanded(true);
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-dockkit-content="${opened}"]`)?.focus());
    return opened;
  }, [controller, owners]);
  return { controller, snapshot, panelId, resources, owners, expand, openContent, shown: snapshot.state.expanded && Object.keys(snapshot.state.tabs).length > 0 };
}

export function PluginPanel({ panel, width, narrow, focus, onExitFocus, plugins, props, cwd }: {
  panel: ReturnType<typeof usePluginPanel>; width: number; narrow: boolean; focus: boolean; onExitFocus: () => void;
  plugins: readonly LoadedPlugin[]; props: PluginHostProps; cwd?: string;
}) {
  const { controller, snapshot, openContent: open } = panel;
  const { state } = snapshot;
  const [closeError, setCloseError] = useState("");
  const closing = useRef(false);
  const intents = useMemo(() => new Proxy(controller, { get(target, key) {
    if (key === "closeTab") return (id: TabId) => {
      if (closing.current) return;
      closing.current = true;
      const sessionId = props.session?.sessionId ?? "";
      void hostedFrames.flush(sessionId).then(async () => {
        const content = document.querySelector(`[data-dockkit-content="${CSS.escape(id)}"]`);
        if (content) await hostedFrames.retireWithin(sessionId, content);
        setCloseError(""); target.closeTab(id);
      })
        .catch(error => setCloseError(error instanceof Error ? error.message : String(error)))
        .finally(() => { closing.current = false; });
    };
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } }), [controller, props.session?.sessionId]);
  const fullscreen = narrow || state.mode === "fullscreen";
  const dictionary: Record<string, string> = props.locale === "zh" ? zh : en;
  const t = (key: string) => dictionary[key] ?? key;
  const text = (value: string | { zh: string; en: string }) => typeof value === "string" ? value : value[props.locale];
  const panels = plugins.flatMap(plugin => (plugin.definition.workbench?.panels ?? []).map(contribution => ({ plugin, contribution })));
  const collapse = () => { onExitFocus(); controller.setExpanded(false); requestAnimationFrame(() => document.querySelector<HTMLButtonElement>("[data-sidebar-right-expand]")?.focus()); };
  const panelWidth = narrow ? "100vw" : width;
  return <div className={css.panel} style={{ width: panelWidth, "--dsh-sidebar-width": typeof panelWidth === "number" ? `${panelWidth}px` : panelWidth } as CSSProperties}
    data-sidebar-right-session={props.session?.sessionId} data-sidebar-right-panel={fullscreen ? "fullscreen" : focus ? "focus" : "push"} data-sidebar-right-open={panel.shown || undefined} aria-hidden={!panel.shown || undefined}>
    <div className={css.panelBody}>{closeError && <p role="alert">{closeError}</p>}<DockLayout state={state} canSplit={snapshot.canSplit && dockPaneIds(state).length < 2} dropZones="horizontal" minPaneFraction={0.2}
      intents={intents} labels={dockLabels(t)} active keepMounted={() => true}
      renderTab={tab => {
        const paneId = findTabPane(state, tab.id).id;
        const visible = state.expanded && getPane(state, paneId).activeTabId === tab.id;
        if (tab.kind === "guide") return <div className={filesCss.guide}>
          <div className={filesCss.guideGrid} role="group" aria-label={localize("工作区工具", "Workspace tools")}>
            {plugins.map(plugin => {
              const entry = plugin.definition.workbench?.entry;
              if (!entry) return null;
              const Icon = entry.icon;
              return <button key={plugin.id} type="button" className={filesCss.guideEntry} disabled={!props.session || !cwd} aria-label={text(entry.label)} onClick={() => open(entry.kind, entry.multiple ? randomUUID() : "workspace", text(entry.panelTitle ?? entry.label), paneId, plugin.id)}>
                <span className={filesCss.guideIcon} aria-hidden="true"><Icon size={24} /></span>
                <span className={filesCss.guideCopy}>
                  <span className={filesCss.guideLabel}>{text(entry.label)}</span>
                  <span className={filesCss.guideDescription}>{text(entry.description)}</span>
                </span>
              </button>;
            })}
            {!plugins.some(plugin => plugin.definition.workbench) && <p className={filesCss.state}>{localize("没有已启用的工作区插件，可在设置中启用。", "No workspace plugins enabled. Enable one in Settings.")}</p>}
          </div>
        </div>;
        const registered = panels.find(item => item.contribution.kind === tab.kind);
        if (registered && props.session) {
          const { plugin, contribution } = registered;
          panel.owners.set(tab.id, plugin.id);
          const Component = contribution.component;
          const resource: WorkbenchPanelProps["resource"] = (create, dispose, activate) => {
            let existing = panel.resources.get(tab.id);
            if (!existing) {
              const value = create();
              existing = { value, dispose: () => dispose?.(value), activate: active => activate?.(value, active) };
              panel.resources.set(tab.id, existing);
            }
            return existing.value as ReturnType<typeof create>;
          };
          return <PluginBoundary id={plugin.id}><Component sendMessage={props.sendMessage} session={props.session} locale={props.locale} visible={visible} contentId={tab.contentId} title={tab.title} renderMarkdown={props.renderMarkdown} resource={resource} open={(kind, id, title) => open(kind, id, title, paneId, plugin.id)} /></PluginBoundary>;
        }
        return <PluginSlot plugins={plugins} slot="rightbar.panel" props={{ ...props, panelId: tab.contentId }} />;
      }}
      renderTabTitle={tab => {
        if (tab.kind === "guide") return t("tab.guide.title");
        const registered = panels.find(item => item.contribution.kind === tab.kind);
        if (registered) return <span className={filesCss.title}>{registered.contribution.title?.(tab.contentId, tab.title) ?? tab.title}</span>;
        return <PluginSlot plugins={plugins} slot="rightbar.title" props={{ ...props, panelId: tab.contentId }} />;
      }}
      chrome={<PanelChrome sessionId={props.session?.sessionId ?? ""} fullscreen={fullscreen || focus} focus={focus} shortcuts={[]} t={t} actions={{ toggleExpanded: collapse }} toggleFullscreen={() => focus ? onExitFocus() : narrow ? collapse() : controller.setMode(fullscreen ? "push" : "fullscreen")} />} />
    </div>
  </div>;
}

export function PluginPanelExpand({ panel, locale }: { panel: ReturnType<typeof usePluginPanel>; locale: "zh" | "en" }) {
  if (panel.shown) return null;
  const dictionary = locale === "zh" ? zh : en;
  return <Tooltip label={dictionary["chrome.expand"]} side="bottom" delayMs={500}><Button size="sm" className={expandCss.button} aria-label={dictionary["chrome.expandAria"]}
    data-sidebar-right-expand onClick={panel.expand}><IconPanelLeftOutlineRegular className={expandCss.icon} /></Button></Tooltip>;
}
