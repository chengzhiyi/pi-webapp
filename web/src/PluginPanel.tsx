import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useSyncExternalStore, type CSSProperties } from "react";
import { DockController, DockLayout, getPane, getTab, dockPaneIds, findTabPane, activeDockPaneId, type PaneId, type TabId } from "./ui/shared/dockkit/index.ts";
import { PanelChrome } from "./ui/shared/sidebar/PanelChrome.tsx";
import { dockLabels } from "./ui/shared/sidebar/labels.ts";
import { zh, en } from "./ui/shared/sidebar/locales.ts";
import { Button } from "./ui/shared/primitives/Button.tsx";
import { Tooltip } from "./ui/shared/primitives/Tooltip.tsx";
import { IconBranchOutlineRegular, IconPanelLeftOutlineRegular } from "./ui/shared/primitives/icons/index.tsx";
import css from "./ui/shared/sidebar/SidebarRight.module.css";
import expandCss from "./ui/shared/sidebar/ExpandButton.module.css";
import { PluginSlot, type LoadedPlugin, type PluginHostProps } from "./plugin-runtime.tsx";
import { FileTypeIcon } from "./ui/primitives/FileTypeIcon.tsx";
import { localize } from "./ui/locale/preference.ts";
import { WorkspaceFiles, createWorkspaceTree, type WorkspaceTreeState } from "./WorkspaceFiles.tsx";
import { WorkspaceFilePreview } from "./WorkspaceFilePreview.tsx";
import { WorkspaceGit } from "./WorkspaceGit.tsx";
import { gitAreaLabel } from "./git-labels.ts";
import { WorkspaceGitDiff } from "./WorkspaceGitDiff.tsx";
import { WorkspaceGitCommit, WorkspaceGitCommitDiff } from "./WorkspaceGitCommit.tsx";
import { createGitPanelModel, type GitPanelModel } from "./git-panel-model.ts";
import type { GitDiffArea } from "../../shared/workspace-git.ts";
import type { TerminalSession } from "./terminal-session.ts";
import { randomUUID } from "./random-uuid.ts";
import filesCss from "./workspace-files.module.css";

const WorkspaceTerminal = lazy(() => import("./WorkspaceTerminal.tsx").then(module => ({ default: module.WorkspaceTerminal })));

/** Each session retains its own DSH docking controller across navigation. */
export function usePluginPanel(sessionId: string | undefined) {
  const controllers = useRef(new Map<string, { controller: DockController; trees: Map<string, WorkspaceTreeState>; terminals: Map<string, TerminalSession>; gitPanels: Map<string, GitPanelModel> }>());
  const { controller, trees, terminals, gitPanels } = useMemo(() => {
    const key = sessionId ?? "";
    let value = controllers.current.get(key);
    if (!value) {
      const guide = (id: TabId) => ({ id, kind: "guide", contentId: "guide", title: "开始" });
      value = { controller: new DockController({ makeInitialTab: guide, makePaneTab: guide }), trees: new Map(), terminals: new Map(), gitPanels: new Map() };
      const owned = value;
      owned.controller.subscribe(() => {
        const tabs = owned.controller.getSnapshot().state.tabs;
        for (const [id, terminal] of owned.terminals) if (!tabs[id as TabId]) { terminal.dispose(); owned.terminals.delete(id); }
      });
      controllers.current.set(key, value);
    }
    return value;
  }, [sessionId]);
  useEffect(() => {
    for (const [id, value] of controllers.current) for (const terminal of value.terminals.values()) terminal.activate(id === sessionId);
  }, [sessionId]);
  useEffect(() => () => { for (const value of controllers.current.values()) for (const terminal of value.terminals.values()) terminal.dispose(); }, []);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const { state } = snapshot;
  const activeTab = getPane(state, state.activePaneId).activeTabId;
  const tab = activeTab ? getTab(state, activeTab) : undefined;
  const panelId = tab?.kind === "plugin" ? tab.contentId : null;
  useEffect(() => { for (const models of [trees, gitPanels]) for (const id of models.keys()) if (!state.tabs[id as TabId]) models.delete(id); }, [state.tabs, trees, gitPanels]);
  const expand = () => {
    if (Object.keys(controller.getSnapshot().state.tabs).length === 0) controller.openContent({ kind: "guide", contentId: "guide", title: "开始" });
    controller.setExpanded(true);
  };
  const openContent = useCallback((kind: string, contentId: string, title: string, paneId?: PaneId) => {
    const current = controller.getSnapshot().state;
    const target = paneId && getPane(current, paneId).host === "dock" ? paneId : activeDockPaneId(current);
    const pane = getPane(current, target);
    const guide = pane.activeTabId && current.tabs[pane.activeTabId]?.kind === "guide" ? pane.activeTabId : undefined;
    const existing = kind === "files" ? pane.tabs.find(id => current.tabs[id]?.kind === kind && current.tabs[id]?.contentId === contentId) : undefined;
    const opened = existing ?? controller.openContent({ kind, contentId, title, paneId: target, revealIfOpened: kind !== "files" });
    if (existing) controller.focusTab(existing);
    if (guide) controller.closeTab(guide);
    controller.setExpanded(true);
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-dockkit-content="${opened}"]`)?.focus());
  }, [controller]);
  return { controller, snapshot, panelId, trees, terminals, gitPanels, expand, openContent, shown: state.expanded && Object.keys(state.tabs).length > 0 };
}

export function PluginPanel({ panel, width, narrow, plugins, props, cwd }: {
  panel: ReturnType<typeof usePluginPanel>; width: number; narrow: boolean;
  plugins: readonly LoadedPlugin[]; props: PluginHostProps; cwd?: string;
}) {
  const { controller, snapshot, openContent: open } = panel;
  const openCommit = useCallback((hash: string, paneId: PaneId) => open("git-commit", hash, hash.slice(0, 7), paneId), [open]);
  const { state } = snapshot;
  const fullscreen = narrow || state.mode === "fullscreen";
  const dictionary: Record<string, string> = props.locale === "zh" ? zh : en;
  const t = (key: string) => dictionary[key] ?? key;
  const collapse = () => {
    controller.setExpanded(false);
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>("[data-sidebar-right-expand]")?.focus());
  };
  return <div className={css.panel} style={{ width: fullscreen ? "100vw" : width, "--dsh-sidebar-width": fullscreen ? "100vw" : `${width}px` } as CSSProperties}
    data-sidebar-right-session={props.session?.sessionId} data-sidebar-right-panel={fullscreen ? "fullscreen" : "push"} data-sidebar-right-open={panel.shown || undefined} aria-hidden={!panel.shown || undefined}>
    <div className={css.panelBody}><DockLayout state={state} canSplit={snapshot.canSplit && dockPaneIds(state).length < 2} dropZones="horizontal" minPaneFraction={0.2}
      intents={controller} labels={dockLabels(t)} active keepMounted={() => true}
      renderTab={(tab) => {
        const paneId = findTabPane(state, tab.id).id;
        const openFiles = () => open("files", "workspace", localize("工作区文件", "Workspace files"), paneId);
        const openTerminal = () => open("terminal", randomUUID(), localize("终端", "Terminal"), paneId);
        const visible = state.expanded && getPane(state, paneId).activeTabId === tab.id;
        if (tab.kind === "git" && props.session) {
          let model = panel.gitPanels.get(tab.id);
          if (!model) { model = createGitPanelModel(); panel.gitPanels.set(tab.id, model); }
          return <WorkspaceGit sessionId={props.session.sessionId} visible={visible} idle={props.session.idle} paneId={paneId} model={model} onCommit={openCommit} />;
        }
        if (tab.kind === "git-commit" && props.session) return <WorkspaceGitCommit sessionId={props.session.sessionId} hash={tab.contentId} visible={visible} idle={props.session.idle} paneId={paneId} onCommit={openCommit} />;
        if (tab.kind === "git-commit-diff" && props.session) {
          const [hash, parentIndex, path] = JSON.parse(tab.contentId) as [string, number, string];
          return <WorkspaceGitCommitDiff sessionId={props.session.sessionId} hash={hash} parentIndex={parentIndex} path={path} visible={visible} idle={props.session.idle} />;
        }
        if (tab.kind === "git-diff" && props.session) {
          const [area, path] = JSON.parse(tab.contentId) as [GitDiffArea, string];
          return <WorkspaceGitDiff sessionId={props.session.sessionId} path={path} area={area} visible={visible} idle={props.session.idle} />;
        }
        if (tab.kind === "terminal" && props.session) {
          return <Suspense fallback={null}><WorkspaceTerminal models={panel.terminals} tabId={tab.id} id={tab.contentId} sessionId={props.session.sessionId} visible={state.expanded && getPane(state, paneId).activeTabId === tab.id} onNew={openTerminal} /></Suspense>;
        }
        if (tab.kind === "guide") return <div className={filesCss.guide}>
          <h2 className={filesCss.guideHeading}>{localize("工作区工具", "Workspace tools")}</h2>
          <button type="button" className={filesCss.guideEntry} disabled={!props.session || !cwd} aria-label={localize("工作区文件", "Workspace files")} onClick={openFiles}>
            <FileTypeIcon kind="folder" size={28} /><span className={filesCss.guideCopy}><span>{localize("工作区文件", "Workspace files")}</span><span className={filesCss.guideDescription}>{localize("浏览当前会话的文件并打开预览", "Browse this session’s files and open previews")}</span></span>
          </button>
          <button type="button" className={filesCss.guideEntry} disabled={!props.session || !cwd} aria-label={localize("打开终端", "Open terminal")} onClick={openTerminal}>
            <span aria-hidden="true" style={{ fontFamily: "monospace", fontSize: 24, width: 28 }}>›_</span><span className={filesCss.guideCopy}><span>{localize("打开终端", "Open terminal")}</span><span className={filesCss.guideDescription}>{localize("在当前工作区中运行交互式 Shell", "Run an interactive shell in this workspace")}</span></span>
          </button>
          <button type="button" className={filesCss.guideEntry} disabled={!props.session || !cwd} aria-label={localize("Git 改动", "Git changes")} onClick={() => open("git", "workspace", "Git", paneId)}>
            <IconBranchOutlineRegular size={28} /><span className={filesCss.guideCopy}><span>{localize("Git 改动", "Git changes")}</span><span className={filesCss.guideDescription}>{localize("查看分支、工作区改动与文件差异", "Review branches, workspace changes and file diffs")}</span></span>
          </button>
        </div>;
        if (tab.kind === "files" && props.session && cwd) {
          let tree = panel.trees.get(tab.id);
          if (!tree) { tree = createWorkspaceTree(); panel.trees.set(tab.id, tree); }
          return <WorkspaceFiles sessionId={props.session.sessionId} cwd={cwd} state={tree} onOpen={path => open("file-preview", path, path.split("/").at(-1)!, paneId)} />;
        }
        if (tab.kind === "file-preview" && props.session) return <WorkspaceFilePreview sessionId={props.session.sessionId} path={tab.contentId} renderMarkdown={props.renderMarkdown} />;
        return <PluginSlot plugins={plugins} slot="rightbar.panel" props={{ ...props, panelId: tab.contentId }} />;
      }}
      renderTabTitle={(tab) => tab.kind === "guide" ? t("tab.guide.title")
        : tab.kind === "git" ? <span className={filesCss.title}><IconBranchOutlineRegular /><span>Git</span></span>
        : tab.kind === "git-commit" ? <span className={filesCss.title}><IconBranchOutlineRegular /><span>{tab.title}</span></span>
        : tab.kind === "git-commit-diff" ? <span className={filesCss.title}><FileTypeIcon path={tab.title} size={16} /><span>{tab.title} · {(JSON.parse(tab.contentId) as [string, number, string])[0].slice(0, 7)}</span></span>
        : tab.kind === "git-diff" ? <span className={filesCss.title}><FileTypeIcon path={tab.title} size={16} /><span>{tab.title} · {gitAreaLabel((JSON.parse(tab.contentId) as [GitDiffArea, string])[0])}</span></span>
        : tab.kind === "terminal" ? <span className={filesCss.title}><span aria-hidden="true">›_</span><span>{localize("终端", "Terminal")}</span></span>
        : tab.kind === "files" || tab.kind === "file-preview" ? <span className={filesCss.title} title={tab.kind === "files" ? cwd : tab.contentId}>
          {tab.kind === "files" ? <FileTypeIcon kind="folder" size={16} /> : <FileTypeIcon path={tab.contentId} size={16} />}<span>{tab.kind === "files" ? localize("文件", "Files") : tab.title}</span>
        </span> : <PluginSlot plugins={plugins} slot="rightbar.title" props={{ ...props, panelId: tab.contentId }} />}
      chrome={<PanelChrome sessionId={props.session?.sessionId ?? ""} fullscreen={fullscreen} shortcuts={[]} t={t} actions={{ toggleExpanded: collapse }} toggleFullscreen={() => narrow ? collapse() : controller.setMode(fullscreen ? "push" : "fullscreen")} />} />
    </div>
  </div>;
}

export function PluginPanelExpand({ panel, locale }: { panel: ReturnType<typeof usePluginPanel>; locale: "zh" | "en" }) {
  if (panel.shown) return null;
  const dictionary = locale === "zh" ? zh : en;
  return <Tooltip label={dictionary["chrome.expand"]} side="bottom" delayMs={500}><Button size="sm" className={expandCss.button} aria-label={dictionary["chrome.expandAria"]}
    data-sidebar-right-expand onClick={panel.expand}><IconPanelLeftOutlineRegular className={expandCss.icon} /></Button></Tooltip>;
}
