import { useMemo, useRef, useSyncExternalStore, type CSSProperties } from "react";
import { DockController, DockLayout, getPane, getTab, dockPaneIds } from "./ui/dsh/dockkit/index.ts";
import { PanelChrome } from "./ui/dsh/sidebar/PanelChrome.tsx";
import { dockLabels } from "./ui/dsh/sidebar/labels.ts";
import { zh, en } from "./ui/dsh/sidebar/locales.ts";
import { Button } from "./ui/dsh/primitives/Button.tsx";
import { Tooltip } from "./ui/dsh/primitives/Tooltip.tsx";
import { IconPanelLeftOutlineRegular } from "./ui/dsh/primitives/icons/index.tsx";
import css from "./ui/dsh/sidebar/SidebarRight.module.css";
import expandCss from "./ui/dsh/sidebar/ExpandButton.module.css";
import { PluginSlot, type LoadedPlugin, type PluginHostProps } from "./plugin-runtime.tsx";

/** Each session retains its own DSH docking controller across navigation. */
export function usePluginPanel(sessionId: string | undefined) {
  const controllers = useRef(new Map<string, DockController>());
  const controller = useMemo(() => {
    const key = sessionId ?? "";
    let value = controllers.current.get(key);
    if (!value) {
      value = new DockController({ makePaneTab: (id) => ({ id, kind: "guide", contentId: "guide", title: "开始" }) });
      controllers.current.set(key, value);
    }
    return value;
  }, [sessionId]);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const { state } = snapshot;
  const activeTab = getPane(state, state.activePaneId).activeTabId;
  const panelId = activeTab ? getTab(state, activeTab).contentId : null;
  return { controller, snapshot, panelId, shown: state.expanded && Object.keys(state.tabs).length > 0 };
}

export function PluginPanel({ panel, width, narrow, plugins, props }: {
  panel: ReturnType<typeof usePluginPanel>; width: number; narrow: boolean;
  plugins: readonly LoadedPlugin[]; props: PluginHostProps;
}) {
  const { controller, snapshot } = panel;
  const { state } = snapshot;
  const fullscreen = narrow || state.mode === "fullscreen";
  const dictionary: Record<string, string> = props.locale === "zh" ? zh : en;
  const t = (key: string) => dictionary[key] ?? key;
  return <div className={css.panel} style={{ width: fullscreen ? "100vw" : width, "--dsh-sidebar-width": fullscreen ? "100vw" : `${width}px` } as CSSProperties}
    data-sidebar-right-session={props.session?.sessionId} data-sidebar-right-panel={fullscreen ? "fullscreen" : "push"} data-sidebar-right-open={panel.shown || undefined} aria-hidden={!panel.shown || undefined}>
    <div className={css.panelBody}><DockLayout state={state} canSplit={snapshot.canSplit && dockPaneIds(state).length < 2} dropZones="horizontal" minPaneFraction={0.2}
      intents={controller} labels={dockLabels(t)} active keepMounted={() => true}
      renderTab={(tab) => tab.kind === "guide" ? <p className={css.unavailable}>{props.locale === "zh" ? "从对话中打开扩展文档。" : "Open an extension document from the conversation."}</p> : <PluginSlot plugins={plugins} slot="rightbar.panel" props={{ ...props, panelId: tab.contentId }} />}
      renderTabTitle={(tab) => tab.kind === "guide" ? t("tab.guide.title") : <PluginSlot plugins={plugins} slot="rightbar.title" props={{ ...props, panelId: tab.contentId }} />}
      chrome={<PanelChrome sessionId={props.session?.sessionId ?? ""} fullscreen={fullscreen} shortcuts={[]} t={t} actions={{ toggleExpanded: () => controller.toggleExpanded() }} toggleFullscreen={() => narrow ? controller.setExpanded(false) : controller.setMode(fullscreen ? "push" : "fullscreen")} />} />
    </div>
  </div>;
}

export function PluginPanelExpand({ panel, locale }: { panel: ReturnType<typeof usePluginPanel>; locale: "zh" | "en" }) {
  if (panel.shown || Object.keys(panel.snapshot.state.tabs).length === 0) return null;
  const dictionary = locale === "zh" ? zh : en;
  return <Tooltip label={dictionary["chrome.expand"]} side="bottom" delayMs={500}><Button size="sm" className={expandCss.button} aria-label={dictionary["chrome.expandAria"]}
    data-sidebar-right-expand onClick={() => panel.controller.setExpanded(true)}><IconPanelLeftOutlineRegular className={expandCss.icon} /></Button></Tooltip>;
}
