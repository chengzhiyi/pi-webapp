import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { TabContextReport } from "../../../../contracts/workbench.ts";
import { fileContext, type LineRange } from "./file-context.ts";
import { IconPanelLeftOutlineRegular, IconRefreshOutlineRegular, IconSearchOutlineRegular } from "../../../../../web/src/ui/shared/primitives/icons/index.tsx";
import { IconFolderClose16 } from "../../../../../web/src/ui/primitives/index.ts";
import { localize as t } from "../../../../../web/src/ui/locale/preference.ts";
import { WorkspaceFilePreview } from "./WorkspaceFilePreview.tsx";
import { FileBreadcrumb } from "./FileBreadcrumb.tsx";
import { FileTree } from "./FileTree.tsx";
import { FileSearchResults } from "./FileSearch.tsx";
import { emptyStatus, statusIndex, type StatusIndex } from "./file-status.ts";
import { workspaceFilesApi } from "./workspace-files-api.ts";
import type { WorkspaceFileListing } from "../contract/workspace-files.ts";
import css from "../../../../../web/src/ui/workbench/WorkspacePanel.module.css";

/** Tab-owned state survives session switches and moving between dock panes. */
export interface WorkspaceTreeState {
  expanded: Set<string>;
  levels: Map<string, WorkspaceFileListing>;
  scrollTop: number;
  /** The previewed file belongs to one workspace; another session's cwd shows nothing. */
  selected: { cwd: string; path: string } | null;
  treeOpen: boolean;
  query: string;
  status: StatusIndex;
}
export const createWorkspaceTree = (): WorkspaceTreeState => ({ expanded: new Set(), levels: new Map(), scrollTop: 0, selected: null, treeOpen: true, query: "", status: emptyStatus });

/** Below this panel width the tree and the preview take turns instead of sharing the row. */
const NARROW_WIDTH = 420;

/** Keep the host told which file (and lines) this tab shows; returns the editor's selection callback. */
function useReportedFile(cwd: string, path: string | undefined, report?: (context: TabContextReport | null) => void) {
  const [lines, setLines] = useState<LineRange | null>(null);
  useEffect(() => { setLines(null); }, [path]);
  useEffect(() => { report?.(fileContext(cwd, path, lines)); }, [report, cwd, path, lines]);
  useEffect(() => () => report?.(null), [report]);
  return useCallback((next: LineRange | null) => setLines(current => current?.from === next?.from && current?.to === next?.to ? current : next), []);
}

function TreeToggle({ open, controls, onToggle }: { open: boolean; controls: string; onToggle(): void }) {
  const label = open ? t("隐藏文件目录", "Hide file tree") : t("显示文件目录", "Show file tree");
  return <button type="button" className={`${css.iconButton} ${css.treeToggle}`} aria-label={label} title={label}
    aria-expanded={open} aria-controls={controls} onClick={onToggle}><IconPanelLeftOutlineRegular /></button>;
}

/** Preview on the left, directory tree on the right; the breadcrumb switches files without the tree. */
export const WorkspaceFiles = memo(function WorkspaceFiles({ sessionId, cwd, idle, state, renderMarkdown, reportContext }: {
  sessionId: string; cwd: string; idle: boolean; state: WorkspaceTreeState;
  renderMarkdown(text: string, pathImages?: { resolve(value: string): string | undefined }): ReactNode;
  reportContext?(context: TabContextReport | null): void;
}) {
  const [expanded, setExpanded] = useState(() => new Set(state.expanded));
  const [selected, setSelected] = useState(() => state.selected);
  const [treeOpen, setTreeOpen] = useState(state.treeOpen);
  const [revision, setRevision] = useState(0);
  const [narrow, setNarrow] = useState(false);
  const [query, setQuery] = useState(state.query);
  const [status, setStatus] = useState(state.status);
  const [reveal, setReveal] = useState<{ line: number }>();
  const [search, setSearch] = useState<HTMLInputElement | null>(null);
  const layout = useRef<HTMLDivElement>(null);
  const dirty = useRef(false);
  const onDirtyChange = useCallback((value: boolean) => { dirty.current = value; }, []);
  // Reload the tree, its Git colours and an unedited preview whenever the agent finishes a turn.
  const statusRequest = useRef<AbortController | null>(null);
  const loadStatus = useCallback(() => {
    statusRequest.current?.abort();
    const controller = new AbortController();
    statusRequest.current = controller;
    void workspaceFilesApi.status(sessionId, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      const next = statusIndex(value);
      state.status = next; setStatus(next);
    }).catch(() => { /* Decoration only: the tree works without it. */ });
  }, [sessionId, state]);
  useEffect(() => { loadStatus(); return () => statusRequest.current?.abort(); }, [loadStatus]);
  const reloadAll = useCallback(() => { setRevision(value => value + 1); loadStatus(); }, [loadStatus]);
  const wasIdle = useRef(idle);
  useEffect(() => {
    if (idle && !wasIdle.current) reloadAll();
    wasIdle.current = idle;
  }, [idle, reloadAll]);
  const onSaved = loadStatus;
  const changeQuery = (value: string) => { state.query = value; setQuery(value); };
  const treeId = `files-tree-${sessionId}`;
  const path = selected?.cwd === cwd ? selected.path : undefined;
  const lines = useReportedFile(cwd, path, reportContext);
  // Runs whenever the tree column mounts, including after it is shown again.
  const restoreScroll = useCallback((element: HTMLDivElement | null) => { if (element) element.scrollTop = state.scrollTop; }, [state]);
  useLayoutEffect(() => {
    const element = layout.current;
    if (!element) return;
    const measure = () => setNarrow(element.clientWidth < NARROW_WIDTH);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const setExpandedState = (update: (previous: Set<string>) => Set<string>) => setExpanded(previous => {
    const next = update(previous);
    state.expanded = next;
    return next;
  });
  const toggle = (directory: string) => setExpandedState(previous => {
    const next = new Set(previous);
    if (next.has(directory)) next.delete(directory); else next.add(directory);
    return next;
  });
  const showTree = (value: boolean) => { state.treeOpen = value; setTreeOpen(value); };
  const open = (file: string, line?: number) => {
    if (file !== path && dirty.current && !window.confirm(t("放弃未保存的更改？", "Discard unsaved changes?"))) return;
    setReveal(line ? { line } : undefined);
    const next = { cwd, path: file };
    state.selected = next; setSelected(next);
    // Reveal a file chosen from the breadcrumb in the side tree as well.
    const parts = file.split("/").slice(0, -1);
    if (parts.length) setExpandedState(previous => {
      const ancestors = parts.map((_, index) => parts.slice(0, index + 1).join("/"));
      return ancestors.every(item => previous.has(item)) ? previous : new Set([...previous, ...ancestors]);
    });
    if (narrow) showTree(false);
  };
  const breadcrumb = <FileBreadcrumb sessionId={sessionId} cwd={cwd} path={path} levels={state.levels} onOpen={open} />;
  const toggleTree = !treeOpen && <TreeToggle open={false} controls={treeId} onToggle={() => showTree(true)} />;
  return <div ref={layout} className={css.files} data-narrow={narrow || undefined} data-tree-open={treeOpen || undefined}>
    <div className={css.filesMain}>
      {path
        ? <WorkspaceFilePreview key={path} sessionId={sessionId} path={path} renderMarkdown={renderMarkdown} breadcrumb={breadcrumb} trailing={toggleTree}
          refresh={revision} reveal={reveal} onDirtyChange={onDirtyChange} onSaved={onSaved} onSelection={lines} />
        : <div className={css.body}>
          <div className={css.toolbar}>{breadcrumb}{toggleTree}</div>
          <div className={css.emptyFile}>
            <IconFolderClose16 size={28} className={css.emptyFileIcon} />
            <p className={css.emptyFileTitle}>{t("打开的文件显示在这里", "Open files appear here")}</p>
            <p className={css.emptyFileHint}>{t("请在目录树中选择一个文件，或在对话中点击文件路径。", "Choose a file in the tree, or click a file path in the chat.")}</p>
          </div>
        </div>}
    </div>
    {treeOpen && <aside id={treeId} className={css.filesSide} aria-label={t("文件目录", "File tree")}>
      <div className={css.toolbar}>
        <label className={css.search} title={cwd}>
          <IconSearchOutlineRegular />
          <input ref={setSearch} type="search" value={query} placeholder={t("筛选，或输入 ? 在文件中搜索", "Filter, or type ? to search in files")}
            aria-label={t("筛选文件，或以 ? 开头在文件内容中搜索", "Filter files, or start with ? to search file contents")}
            onChange={event => changeQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key === "Escape" && query) { event.preventDefault(); event.stopPropagation(); changeQuery(""); }
              else if (event.key === "Enter" || event.key === "ArrowDown") {
                const first = event.currentTarget.closest("aside")?.querySelector<HTMLButtonElement>("button[data-search-result]");
                if (!first) return;
                event.preventDefault();
                if (event.key === "Enter") first.click(); else first.focus();
              }
            }} />
        </label>
        <button type="button" className={css.iconButton} aria-label={t("重新读取文件列表", "Reload files")} title={t("重新读取文件列表", "Reload files")} onClick={reloadAll}><IconRefreshOutlineRegular /></button>
        <TreeToggle open controls={treeId} onToggle={() => showTree(false)} />
      </div>
      {query.trim()
        ? <div className={css.scroll}>
          <FileSearchResults key={revision} sessionId={sessionId} query={query} input={search} onOpen={open} />
        </div>
        : <div ref={restoreScroll} className={css.scroll} onScroll={event => { state.scrollTop = event.currentTarget.scrollTop; }}>
          <FileTree root="" label={t("工作区文件", "Workspace files")} sessionId={sessionId} levels={state.levels} revision={revision}
            expanded={expanded} selected={path} status={status} toggle={toggle} open={open} />
        </div>}
    </aside>}
  </div>;
});

/** A standalone preview tab (opened from a chat link); its breadcrumb opens other files in new tabs. */
export function WorkspaceFileTab({ sessionId, cwd, path, levels, renderMarkdown, open, reportContext }: {
  sessionId: string; cwd: string; path: string; levels: Map<string, WorkspaceFileListing>; open(path: string): void;
  renderMarkdown(text: string, pathImages?: { resolve(value: string): string | undefined }): ReactNode;
  reportContext?(context: TabContextReport | null): void;
}) {
  const lines = useReportedFile(cwd, path, reportContext);
  // The host recreates `open` on every render; a stable callback keeps the memoized preview from re-rendering.
  const latest = useRef(open);
  useLayoutEffect(() => { latest.current = open; });
  const onOpen = useCallback((file: string) => latest.current(file), []);
  const breadcrumb = useMemo(() => <FileBreadcrumb sessionId={sessionId} cwd={cwd} path={path} levels={levels} onOpen={onOpen} />, [sessionId, cwd, path, levels, onOpen]);
  return <WorkspaceFilePreview sessionId={sessionId} path={path} renderMarkdown={renderMarkdown} breadcrumb={breadcrumb} onSelection={lines} />;
}
