import { useEffect, useState, type KeyboardEvent } from "react";
import { FileTypeIcon } from "../../../../../web/src/ui/primitives/FileTypeIcon.tsx";
import { IconFolderOpen16 } from "../../../../../web/src/ui/primitives/index.ts";
import { localize as t } from "../../../../../web/src/ui/locale/preference.ts";
import { workspaceFilesApi } from "./workspace-files-api.ts";
import { emptyStatus, statusLabel, type StatusIndex } from "./file-status.ts";
import type { WorkspaceFileListing } from "../contract/workspace-files.ts";
import css from "../../../../../web/src/ui/workbench/WorkspacePanel.module.css";

export interface TreeProps {
  sessionId: string;
  levels: Map<string, WorkspaceFileListing>;
  revision: number;
  expanded: Set<string>;
  selected: string | undefined;
  /** Denser rows and smaller icons, for the breadcrumb menu. */
  compact?: boolean;
  /** Git decoration; absent outside a repository. */
  status?: StatusIndex;
  toggle(path: string): void;
  open(path: string): void;
}

/** Closed counterpart of IconFolderOpen16: the same tinted body, so open and closed read as one pair. */
function FolderClosed({ size, className }: { size: number; className?: string }) {
  return <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M2.9 2.26h2.3c.55 0 1.06.27 1.37.73l.46.7c.15.23.41.37.69.37h4.58a1.95 1.95 0 0 1 1.95 1.95v5.83a1.95 1.95 0 0 1-1.95 1.95H2.9A1.95 1.95 0 0 1 .95 11.84V4.21A1.95 1.95 0 0 1 2.9 2.26Z"
      fill="currentColor" fillOpacity=".2" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    <path d="M1.2 6.45h13.6" stroke="currentColor" strokeWidth="1.3" />
  </svg>;
}

function DirectoryLevel({ path, depth, tree }: { path: string; depth: number; tree: TreeProps }) {
  const [listing, setListing] = useState(() => tree.levels.get(path));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(false);
    void workspaceFilesApi.list(tree.sessionId, path, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      tree.levels.set(path, value); setListing(value); setLoading(false);
    }).catch(() => {
      if (!controller.signal.aborted) { setError(true); setLoading(false); }
    });
    return () => controller.abort();
  }, [tree.sessionId, tree.levels, path, tree.revision, retry]);
  const icon = tree.compact ? 14 : 16;
  const status = tree.status ?? emptyStatus;

  return <>
    {loading && !listing && <li role="none" className={css.state} aria-live="polite">{t("正在读取…", "Reading…")}</li>}
    {error && <li role="none" className={css.state}><span role="status">{t("目录读取失败，可能已移动、删除或无权访问。", "Could not read this directory. It may have moved, been deleted, or be inaccessible.")}</span> <button type="button" className={css.textButton} onClick={() => setRetry(value => value + 1)}>{t("重试", "Retry")}</button></li>}
    {!loading && !error && listing?.entries.length === 0 && <li role="none" className={css.state}>{t("空目录", "Empty directory")}</li>}
    {listing?.entries.map(entry => {
      const directory = entry.kind === "directory";
      const expanded = directory && tree.expanded.has(entry.path);
      const disabled = entry.kind === "other";
      const state = status.of(entry.path);
      return <li key={entry.path} role="treeitem" tabIndex={disabled ? -1 : 0} aria-label={entry.name} aria-level={depth}
        aria-expanded={directory ? expanded : undefined} aria-disabled={disabled || undefined}
        aria-description={state && statusLabel(state, t)} data-git-status={state}
        aria-selected={directory || disabled ? undefined : entry.path === tree.selected} data-files-path={entry.path}>
        <div className={css.row} style={{ paddingInlineStart: `${(tree.compact ? 8 : 10) + (depth - 1) * (tree.compact ? 12 : 14)}px` }}
          title={disabled ? t("此条目不可访问或位于工作区之外", "This entry is unavailable or outside the workspace") : entry.path}
          onClick={event => {
            if (disabled) return;
            event.currentTarget.parentElement?.focus();
            if (directory) tree.toggle(entry.path); else tree.open(entry.path);
          }}>
          {/* The folder itself shows whether it is open; no separate disclosure arrow. */}
          {directory
            ? expanded ? <IconFolderOpen16 size={icon} className={css.folderIcon} /> : <FolderClosed size={icon} className={css.folderIcon} />
            : <FileTypeIcon path={entry.name} size={icon} />}
          <span className={css.name}>{entry.name}</span>
          {state && state !== "ignored" && <span className={css.statusDot} aria-hidden="true" />}
        </div>
        {expanded && <ul role="group" className={css.level}><DirectoryLevel path={entry.path} depth={depth + 1} tree={tree} /></ul>}
      </li>;
    })}
    {listing?.truncated && <li role="none" className={css.state}>{t("条目太多，只显示前 1000 项。", "Too many entries. Showing the first 1,000.")}</li>}
  </>;
}

/** One keyboard-navigable tree rooted at a workspace directory ("" is the workspace root). */
export function FileTree({ root, label, ...tree }: TreeProps & { root: string; label: string }) {
  const { toggle, open } = tree;
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
      case "Enter": case " ": if (directory) toggle(path); else open(path); break;
      default: return;
    }
    event.preventDefault(); event.stopPropagation(); focus?.focus();
  };
  return <ul role="tree" aria-label={label} className={css.tree} onKeyDown={navigate}>
    <DirectoryLevel path={root} depth={1} tree={tree} />
  </ul>;
}
