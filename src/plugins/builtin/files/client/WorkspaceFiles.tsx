import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { FileTypeIcon } from "../../../../../web/src/ui/primitives/FileTypeIcon.tsx";
import { IconRefreshOutlineRegular } from "../../../../../web/src/ui/shared/primitives/icons/index.tsx";
import { localize as t } from "../../../../../web/src/ui/locale/preference.ts";
import { workspaceFilesApi } from "./workspace-files-api.ts";
import type { WorkspaceFileListing } from "../contract/workspace-files.ts";
import css from "../../../../../web/src/ui/workbench/WorkspacePanel.module.css";

/** Tab-owned state survives session switches and moving between dock panes. */
export interface WorkspaceTreeState {
  expanded: Set<string>;
  levels: Map<string, WorkspaceFileListing>;
  scrollTop: number;
}
export const createWorkspaceTree = (): WorkspaceTreeState => ({ expanded: new Set(), levels: new Map(), scrollTop: 0 });

interface TreeProps {
  sessionId: string;
  state: WorkspaceTreeState;
  revision: number;
  expanded: Set<string>;
  toggle(path: string): void;
  open(path: string): void;
}

function DirectoryLevel({ path, depth, tree }: { path: string; depth: number; tree: TreeProps }) {
  const [listing, setListing] = useState(() => tree.state.levels.get(path));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(false);
    void workspaceFilesApi.list(tree.sessionId, path, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      tree.state.levels.set(path, value); setListing(value); setLoading(false);
    }).catch(() => {
      if (!controller.signal.aborted) { setError(true); setLoading(false); }
    });
    return () => controller.abort();
  }, [tree.sessionId, tree.state, path, tree.revision, retry]);

  return <>
    {loading && <li role="none" className={css.state} aria-live="polite">{t("正在读取…", "Reading…")}</li>}
    {error && <li role="none" className={css.state}><span role="status">{t("目录读取失败，可能已移动、删除或无权访问。", "Could not read this directory. It may have moved, been deleted, or be inaccessible.")}</span> <button type="button" className={css.textButton} onClick={() => setRetry(value => value + 1)}>{t("重试", "Retry")}</button></li>}
    {!loading && !error && listing?.entries.length === 0 && <li role="none" className={css.state}>{t("空目录", "Empty directory")}</li>}
    {listing?.entries.map(entry => {
      const directory = entry.kind === "directory";
      const expanded = directory && tree.expanded.has(entry.path);
      const disabled = entry.kind === "other";
      return <li key={entry.path} role="treeitem" tabIndex={disabled ? -1 : 0} aria-label={entry.name} aria-level={depth}
        aria-expanded={directory ? expanded : undefined} aria-disabled={disabled || undefined} data-files-path={entry.path}>
        <div className={css.row} style={{ paddingInlineStart: `${12 + (depth - 1) * 16}px` }}
          title={disabled ? t("此条目不可访问或位于工作区之外", "This entry is unavailable or outside the workspace") : entry.path}
          onClick={event => {
            if (disabled) return;
            event.currentTarget.parentElement?.focus();
            if (directory) tree.toggle(entry.path); else tree.open(entry.path);
          }}>
          <span className={css.chevron} aria-hidden="true">{directory ? expanded ? "⌄" : "›" : ""}</span>
          {directory ? <FileTypeIcon kind="folder" size={18} /> : <FileTypeIcon path={entry.name} size={18} />}
          <span className={css.name}>{entry.name}</span>
        </div>
        {expanded && <ul role="group" className={css.level}><DirectoryLevel path={entry.path} depth={depth + 1} tree={tree} /></ul>}
      </li>;
    })}
    {listing?.truncated && <li role="none" className={css.state}>{t("条目太多，只显示前 1000 项。", "Too many entries. Showing the first 1,000.")}</li>}
  </>;
}

export function WorkspaceFiles({ sessionId, cwd, state, onOpen }: {
  sessionId: string; cwd: string; state: WorkspaceTreeState; onOpen(path: string): void;
}) {
  const [expanded, setExpanded] = useState(() => new Set(state.expanded));
  const [revision, setRevision] = useState(0);
  const scroll = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (scroll.current) scroll.current.scrollTop = state.scrollTop; }, [state]);
  const toggle = (path: string) => setExpanded(previous => {
    const next = new Set(previous);
    if (next.has(path)) next.delete(path); else next.add(path);
    state.expanded = next;
    return next;
  });
  const tree: TreeProps = { sessionId, state, revision, expanded, toggle, open: onOpen };
  const navigate = (event: KeyboardEvent<HTMLUListElement>) => {
    const row = event.target as HTMLElement;
    if (row.getAttribute("role") !== "treeitem" || row.getAttribute("aria-disabled") === "true") return;
    const path = row.dataset.filesPath!;
    const directory = row.hasAttribute("aria-expanded");
    const opened = row.getAttribute("aria-expanded") === "true";
    const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]:not([aria-disabled="true"])')];
    const index = rows.indexOf(row);
    let focus: HTMLElement | undefined;
    switch (event.key) {
      case "ArrowDown": focus = rows[index + 1]; break;
      case "ArrowUp": focus = rows[index - 1]; break;
      case "Home": focus = rows[0]; break;
      case "End": focus = rows.at(-1); break;
      case "ArrowRight": if (directory && !opened) toggle(path); else if (opened) focus = rows[index + 1]; break;
      case "ArrowLeft": if (opened) toggle(path); else focus = row.parentElement?.closest<HTMLElement>('[role="treeitem"]') ?? undefined; break;
      case "Enter": case " ": if (directory) toggle(path); else onOpen(path); break;
      default: return;
    }
    event.preventDefault(); event.stopPropagation(); focus?.focus();
  };
  return <div className={css.body}>
    <div className={css.toolbar}><span className={css.path} title={cwd} dir="auto">{cwd}</span>
      <button type="button" className={css.iconButton} aria-label={t("重新读取文件列表", "Reload files")} title={t("重新读取文件列表", "Reload files")} onClick={() => setRevision(value => value + 1)}><IconRefreshOutlineRegular /></button>
    </div>
    <div ref={scroll} className={css.scroll} onScroll={event => { state.scrollTop = event.currentTarget.scrollTop; }}>
      <ul role="tree" aria-label={t("工作区文件", "Workspace files")} className={css.tree} onKeyDown={navigate}>
        <DirectoryLevel path="" depth={1} tree={tree} />
      </ul>
    </div>
  </div>;
}
