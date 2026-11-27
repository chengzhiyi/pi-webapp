import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { WorkspaceSessionView } from "../../contracts/bridge-contract.ts";
import { subagentStatusText, subagentTitle } from "./subagent-session-labels.ts";
import { IconFolderOpen16, IconProjectAddOutline16, StateDot, useErrorToast } from "../../../web/src/ui/primitives/index.ts";
import { IconChevronDownOutline14, IconCloseFill14, IconSearchOutline16, IconFolderClose16, IconNewChatOutline16 } from "../../../web/src/ui/primitives/icons/index.tsx";
import { Button } from "../../../web/src/ui/primitives/Button.tsx";
import { Modal } from "../../../web/src/ui/primitives/Modal.tsx";
import { PiSessionActions, PiWorkspaceActions } from "./PiWorkspaceActions.tsx";
import { sessionTimeLabel } from "../../../web/src/ui/workspace/session-time.ts";
import { DirectoryBrowser } from "../../../web/src/ui/workspace/DirectoryBrowser.tsx";
import type { DirectoryListing, DirectoryPickerKind, SessionView, WorkspaceListView } from "./pi-bridge.ts";
import browserCss from "../../../web/src/ui/workspace/WorkspaceBrowser.module.css";
import rowsCss from "../../../web/src/ui/workspace/Rows.module.css";
import css from "./pi-workspaces.module.css";
import { useLocale, localize as t } from "../../../web/src/ui/locale/preference.ts";

interface Props {
  wide: boolean;
  navigationBusy?: boolean;
  connected?: boolean;
  expandSidebar: () => void;
  session: SessionView | null;
  selectedSubagentId: string | null;
  workspaces: WorkspaceListView;
  onAdd: (path: string, create: boolean) => Promise<void>;
  directoryPickerKind: DirectoryPickerKind | null;
  pickDirectory: () => Promise<string | null>;
  listDirectory: (path?: string, signal?: AbortSignal) => Promise<DirectoryListing>;
  createDirectory: (path: string, name: string) => Promise<string>;
  onRemove: (id: string) => Promise<void>;
  onSelectSession: (workspaceId: string, id: string, path: string | null) => Promise<void>;
  onNewSession: (workspaceId: string) => Promise<void>;
  onRenameSession: (workspaceId: string, id: string, path: string | null, name: string) => Promise<void>;
  onDeleteSession: (workspaceId: string, id: string, path: string | null) => Promise<void>;
}

interface SessionTarget { workspaceId: string; id: string; path: string | null; name: string; running: boolean }

/** Workspace browser with a header, workspace groups and session rows. */
const translate = (key: string, params?: Record<string, string>) => {
  const copy: Record<string, string> = {
    "browser.title": t("选择工作区目录", "Select workspace directory"), "browser.home": t("主目录", "Home"), "browser.newFolder": t("新建文件夹", "New folder"),
    "browser.folderName": t("文件夹名称", "Folder name"), "browser.createIn": t("在\"{name}\"中新建文件夹", "Create folder in \"{name}\""),
    "browser.untitledFolder": t("未命名文件夹", "Untitled folder"), "browser.create": t("创建", "Create"), "browser.cancel": t("取消", "Cancel"),
    "browser.open": t("打开", "Open"), "browser.editPath": t("编辑路径", "Edit path"), "browser.loading": t("加载中…", "Loading…"),
    "browser.truncated": t("文件夹过多，仅显示开头部分。", "Too many folders; only the first few are shown."), "browser.showHidden": t("显示隐藏文件", "Show hidden files"),
  };
  return (copy[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => params?.[name] ?? "");
};

export function PiWorkspaceBrowser({ wide, navigationBusy = false, connected = true, expandSidebar, session, selectedSubagentId, workspaces, onAdd, directoryPickerKind, pickDirectory, listDirectory, createDirectory, onRemove, onSelectSession, onNewSession, onRenameSession, onDeleteSession }: Props) {
  const locale = useLocale();
  const [now, setNow] = useState(Date.now);
  const [workspaceMenuId, setWorkspaceMenuId] = useState<string | null>(null);
  const [sessionMenuId, setSessionMenuId] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<SessionTarget | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<SessionTarget | null>(null);
  const renameInput = useRef<HTMLInputElement>(null);
  // Runs after the dialog's own focus handling, so typing replaces the current name.
  useEffect(() => {
    if (!renameTarget) return;
    const frame = requestAnimationFrame(() => { renameInput.current?.focus(); renameInput.current?.select(); });
    return () => cancelAnimationFrame(frame);
  }, [renameTarget]);
  useEffect(() => {
    if (!wide) { setWorkspaceMenuId(null); setSessionMenuId(null); return; }
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [wide]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [working, setBusy] = useState(false);
  const busy = working || navigationBusy;
  const disabled = busy || !connected;
  const listId = useId();
  const root = useRef<HTMLDivElement>(null);
  const [removeTarget, setRemoveTarget] = useState<{ id: string; title: string } | null>(null);
  const [error, setError] = useState("");
  const [addError, setAddError] = useState("");
  const [searchExpanded, setSearchExpanded] = useState(false);
  const [query, setQuery] = useState("");
  useEffect(() => { setQuery(""); }, [session?.sessionId]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (workspaces.activeId) setExpanded((current) => current.has(workspaces.activeId!) ? current : new Set([...current, workspaces.activeId!]));
  }, [workspaces.activeId, session?.sessionId]);
  const searchButton = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const needle = query.trim().toLocaleLowerCase();
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set());
  const tree = useMemo(() => {
    const byId = new Map(workspaces.sessions.map(row => [row.id, row]));
    const roots: WorkspaceSessionView[] = [];
    const orphans: WorkspaceSessionView[] = [];
    const children = new Map<string, WorkspaceSessionView[]>();
    for (const row of workspaces.sessions) {
      if (!row.subagent) { roots.push(row); continue; }
      const parentId = row.subagent.parentSessionId;
      const seen = new Set([row.id]);
      let ancestor = parentId;
      while (ancestor && !seen.has(ancestor)) {
        seen.add(ancestor);
        ancestor = byId.get(ancestor)?.subagent?.parentSessionId ?? null;
      }
      // A cycle cannot be a valid dispatch chain; keep the records reachable.
      if (!parentId || !byId.has(parentId) || ancestor) { orphans.push(row); continue; }
      const siblings = children.get(parentId) ?? [];
      siblings.push(row);
      children.set(parentId, siblings);
    }
    return { byId, roots, orphans, children };
  }, [workspaces.sessions]);
  const selectedLineage = new Set<string>();
  const revealTasks = new Set<string>();
  for (let id = selectedSubagentId; id && !selectedLineage.has(id);) {
    selectedLineage.add(id);
    const orphan = tree.orphans.find(row => row.id === id);
    if (orphan) { revealTasks.add(`orphan-${orphan.workspaceId}`); break; }
    id = tree.byId.get(id)?.subagent?.parentSessionId ?? null;
    if (id) revealTasks.add(id);
  }
  const revealKey = [...revealTasks].join("\n");
  useEffect(() => {
    if (revealKey) setExpandedTasks(current => new Set([...current, ...revealKey.split("\n")]));
  }, [selectedSubagentId, revealKey]);
  useEffect(() => {
    root.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: "nearest" });
  }, [wide, session?.sessionId, selectedSubagentId, expanded, expandedTasks]);
  const matchesText = (value: string) => value.toLocaleLowerCase().includes(needle);
  const matchesRow = (row: WorkspaceSessionView): boolean => matchesText(row.name) || matchesText(subagentTitle(row)) || (tree.children.get(row.id) ?? []).some(matchesRow);
  const workspaceMatches = (workspace: WorkspaceListView["items"][number]) => matchesText(workspace.title) || matchesText(workspace.path);

  const closeSearch = () => {
    setQuery(""); setSearchExpanded(false); searchButton.current?.focus();
  };
  const matchingWorkspaces = workspaces.items.filter((workspace) => workspaceMatches(workspace) || [...tree.roots, ...tree.orphans].some(row => row.workspaceId === workspace.id && matchesRow(row)));
  const toggleTasks = (id: string) => setExpandedTasks(current => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  // Dialogs show their own failures inline; sidebar actions report through a toast.
  useErrorToast("workspace-action", dialogOpen || removeTarget || renameTarget || deleteTarget ? null : error);
  const run = async (action: () => Promise<void>) => {
    if (disabled) return;
    setBusy(true); setError("");
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("操作失败", "Operation failed")); }
    finally { setBusy(false); }
  };
  const add = async (path: string) => {
    setBusy(true);
    try { await onAdd(path, false); setDialogOpen(false); }
    catch (cause) {
      setDialogOpen(false);
      setAddError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };
  const beginPick = async () => {
    if (directoryPickerKind === null) return;
    if (!wide) expandSidebar();
    setError("");
    if (directoryPickerKind === "browse") { setDialogOpen(true); return; }
    setBusy(true);
    try {
      const path = await pickDirectory();
      if (path !== null) await add(path);
    } catch (cause) {
      setAddError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };

  const taskGroupOpen = (id: string) => expandedTasks.has(id) || !!needle;
  function renderTaskToggle(id: string, parentTitle: string, children: WorkspaceSessionView[], unlinked = false): ReactNode {
    const open = taskGroupOpen(id);
    const label = unlinked ? parentTitle : t(`${parentTitle} 的子任务`, `Subtasks for ${parentTitle}`);
    const action = open ? t('收起子任务', 'Collapse subtasks') : t('展开子任务', 'Expand subtasks');
    const status = children.some(row => row.subagent?.status === "failed") ? "failed" : children.some(row => row.subagent?.status === "running") ? "running" : undefined;
    return <button type="button" className={unlinked ? css.taskToggle : css.inlineTaskToggle} aria-label={label} aria-expanded={open} aria-controls={`${listId}-${id}-tasks`} title={status ? `${action} · ${subagentStatusText(status)}` : action} data-status={status} disabled={!!needle} onClick={() => toggleTasks(id)}>
      <span className={open ? css.taskChevronOpen : css.taskChevron}><IconChevronDownOutline14 size={14} /></span>{unlinked && label}
    </button>;
  }

  function renderTaskGroup(id: string, children: WorkspaceSessionView[], showAll: boolean, label: string): ReactNode {
    const visible = showAll ? children : children.filter(matchesRow);
    const open = taskGroupOpen(id) && visible.length > 0;
    return <div className={css.taskGroup} id={`${listId}-${id}-tasks`} role="group" aria-label={label} hidden={!open}>
        {open && visible.map(row => {
          const task = row.subagent!;
          const title = subagentTitle(row);
          const nested = tree.children.get(row.id) ?? [];
          const unavailable = workspaces.items.find(workspace => workspace.id === row.workspaceId)?.available === false;
          return <div key={row.id}>
            <div className={css.taskLine}>
              {nested.length > 0 && renderTaskToggle(row.id, title, nested)}
              <button type="button" className={`${rowsCss.sessionRow} ${css.sessionButton} ${css.taskRow}`} data-has-subtasks={nested.length > 0 || undefined} aria-label={title} aria-current={selectedSubagentId === row.id ? "page" : undefined} disabled={disabled || unavailable} title={title} onClick={() => { void run(() => onSelectSession(row.workspaceId, row.id, row.path)); }}>
                <span className={rowsCss.title}>{title}</span><span className={css.taskStatus} data-status={task.status}>{subagentStatusText(task.status)}</span>
              </button>
            </div>
            {nested.length > 0 && renderTaskGroup(row.id, nested, showAll || matchesText(row.name) || matchesText(title), title)}
          </div>;
        })}
    </div>;
  }

  return <div ref={root} aria-busy={busy} className={`${browserCss.root} ${!wide ? browserCss.rail : ""}`}>
    <div className={browserCss.sectionHeader}>
      {wide && <span className={`${browserCss.sectionLabel} ${browserCss.wide} ${searchExpanded ? browserCss.sectionLabelHidden : ""}`}>{t("工作区", "Workspaces")}</span>}
      {wide && <div className={`${browserCss.searchSlot} ${searchExpanded ? browserCss.searchSlotExpanded : ""}`}><div className={`${browserCss.search} ${searchExpanded ? browserCss.searchExpanded : ""}`} onClick={() => { setSearchExpanded(true); searchInput.current?.focus(); }}>
        <button ref={searchButton} type="button" className={browserCss.searchButton} aria-label={t("搜索工作区和会话", "Search workspaces and sessions")} aria-expanded={searchExpanded} onClick={() => { setSearchExpanded(true); searchInput.current?.focus(); }}><IconSearchOutline16 size={searchExpanded ? 11 : 14} /></button>
        <input ref={searchInput} className={browserCss.searchInput} type="search" aria-label={t("按名称或工作区路径搜索", "Search by name or workspace path")} placeholder={t("按名称或工作区路径搜索", "Search by name or workspace path")} maxLength={120} value={query} tabIndex={searchExpanded ? 0 : -1} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); closeSearch(); } }} />
        {searchExpanded && <button type="button" className={browserCss.clearButton} aria-label={t("关闭搜索", "Close search")} onClick={(event) => { event.stopPropagation(); closeSearch(); }}><IconCloseFill14 /></button>}
      </div></div>}
      <div className={`${browserCss.headerActions} ${wide && searchExpanded ? browserCss.headerActionsHidden : ""}`}>
        <button type="button" className={browserCss.iconButton} aria-label={t("添加工作区", "Add workspace")} title={t("添加工作区", "Add workspace")} disabled={disabled || directoryPickerKind === null} onClick={() => { void beginPick(); }}><IconProjectAddOutline16 size={wide ? 16 : 18} /></button>
      </div>
    </div>
    {wide && <div className={browserCss.listArea}><div className={browserCss.treeBody}><div className={browserCss.list} role="list" aria-label={t("工作区", "Workspaces")}>
      {matchingWorkspaces.map((workspace) => {
        const active = workspace.id === workspaces.activeId;
        const unavailable = workspace.available === false;
        const roots = tree.roots.filter(row => row.workspaceId === workspace.id);
        const orphans = tree.orphans.filter(row => row.workspaceId === workspace.id);
        const open = expanded.has(workspace.id) || !!needle || [...roots, ...orphans].some(row => selectedLineage.has(row.id));
        const showAll = workspaceMatches(workspace);
        const showOrphans = orphans.length > 0 && (showAll || orphans.some(matchesRow));
        const orphanTitle = t("未关联子任务", "Unlinked subtasks");
        return <div key={workspace.id} className={css.group} role="listitem">
          <div className={css.workspaceLine} data-menu-open={workspaceMenuId === workspace.id || undefined}>
            <button type="button" className={`${rowsCss.projectRow} ${css.workspaceButton}`} aria-expanded={open} aria-controls={`${listId}-${workspace.id}`} title={workspace.path} disabled={busy} onContextMenu={event => {
              if (disabled) return;
              event.preventDefault();
              event.stopPropagation();
              setSessionMenuId(null);
              setWorkspaceMenuId(workspace.id);
            }} onClick={() => setExpanded((current) => { const next = new Set(current); if (next.has(workspace.id)) next.delete(workspace.id); else next.add(workspace.id); return next; })}>
              <span className={rowsCss.slot} aria-hidden="true"><span data-workspace-leading="folder" className={`${css.folder} ${active ? css.folderActive : ""}`}>{open ? <IconFolderOpen16 size={16} /> : <IconFolderClose16 size={16} />}</span><span data-workspace-leading="chevron" className={`${css.chevron} ${open ? css.chevronOpen : ""}`}><IconChevronDownOutline14 size={14} /></span></span><span className={`${rowsCss.title} ${css.workspaceTitle}`}>{workspace.title}</span>
              {unavailable && <span className={css.unavailable}>{t("不可用", "Unavailable")}</span>}
            </button>
            <span className={css.rowActions} data-workspace-actions>
              <PiWorkspaceActions workspaceId={workspace.id} unavailable={unavailable} title={workspace.title} active={active} disabled={disabled} open={workspaceMenuId === workspace.id}
                onOpenChange={open => setWorkspaceMenuId(open ? workspace.id : null)} onRemove={() => { setError(""); setRemoveTarget({ id: workspace.id, title: workspace.title }); }} />
              <button type="button" className={css.rowAction} title={unavailable ? t("目录不可用，请恢复目录或移除后重新添加", "Directory unavailable; restore it or remove and add the workspace again") : t("新建会话", "New session")} aria-label={t(`在 ${workspace.title} 新建会话`, `Create a session in ${workspace.title}`)} disabled={disabled || unavailable} onClick={() => { void run(async () => { await onNewSession(workspace.id); setQuery(""); setExpanded(current => new Set([...current, workspace.id])); }); }}><IconNewChatOutline16 size={16} /></button>
            </span>
          </div>
          <div id={`${listId}-${workspace.id}`} role="group" aria-label={workspace.title} hidden={!open}>
          {open && roots.filter(item => showAll || matchesRow(item)).map((item) => {
            const current = !selectedSubagentId && active && session?.sessionId === item.id;
            const running = session?.sessionId === item.id ? !session.idle : item.idle === false;
            const childRows = tree.children.get(item.id) ?? [];
            const title = item.name || t("新会话", "New chat");
            const target = { workspaceId: workspace.id, id: item.id, path: item.path, name: item.name, running };
            return <div key={item.id} className={css.sessionGroup}><div className={css.sessionLine} data-menu-open={sessionMenuId === item.id || undefined}>
              {childRows.length > 0 && renderTaskToggle(item.id, title, childRows)}
              <button type="button" className={`${rowsCss.sessionRow} ${css.sessionButton} ${current ? rowsCss.selected : ""}`} title={title} aria-label={title} aria-describedby={`${listId}-${item.id}-status`} aria-current={current ? "page" : undefined} disabled={disabled || unavailable} onContextMenu={event => {
                if (disabled || unavailable) return;
                event.preventDefault();
                event.stopPropagation();
                setWorkspaceMenuId(null);
                setSessionMenuId(item.id);
              }} onClick={() => { void run(() => onSelectSession(workspace.id, item.id, item.path)); }}>
                <span className={rowsCss.slot}>{running && childRows.length === 0 && <StateDot state="ongoing" />}</span><span className={`${rowsCss.title} ${item.name ? "" : css.untitled}`}>{title}</span>
                {running && childRows.length > 0 && <StateDot state="ongoing" />}
                <time className={css.sessionTime} dateTime={item.modified} title={item.modified}>{sessionTimeLabel(item.modified, now, locale)}</time>
                <span id={`${listId}-${item.id}-status`} className={rowsCss.visuallyHidden}>{running ? t("运行中", "Running") : t("空闲", "Idle")}</span>
              </button>
              <span className={css.rowActions}>
                <PiSessionActions title={title} disabled={disabled || unavailable} open={sessionMenuId === item.id}
                  onOpenChange={open => setSessionMenuId(open ? item.id : null)}
                  onRename={() => { setError(""); setRenameValue(item.name); setRenameTarget(target); }}
                  onDelete={() => { setError(""); setDeleteTarget(target); }} />
              </span>
            </div>{childRows.length > 0 && renderTaskGroup(item.id, childRows, showAll || matchesText(title), title)}</div>;
          })}
          {open && showOrphans && <div className={css.orphanGroup}>
            {renderTaskToggle(`orphan-${workspace.id}`, orphanTitle, orphans, true)}
            {renderTaskGroup(`orphan-${workspace.id}`, orphans, showAll, orphanTitle)}
          </div>}
          {open && !needle && roots.length === 0 && orphans.length === 0 && <p className={browserCss.empty}>{t("还没有会话，创建新会话开始", "No sessions yet. Create a session to start.")}</p>}
          </div>
        </div>;
      })}
      {matchingWorkspaces.length === 0 && <p className={browserCss.empty} role="status">{needle ? t("没有找到匹配的工作区或会话", "No matching workspaces or sessions") : t("添加工作区，开始管理对话", "Add a workspace to start organizing conversations")}{needle && <button type="button" className={browserCss.sessionOverflowButton} onClick={closeSearch}>{t("清除搜索", "Clear search")}</button>}</p>}
      {busy && <p className={browserCss.searchStatus} role="status">{t("正在处理…", "Working…")}</p>}
    </div></div></div>}
    <Modal open={removeTarget !== null} onClose={() => { if (!busy) setRemoveTarget(null); }} title={t("移除工作区？", "Remove workspace?")} closeLabel={t("关闭", "Close")}
      footer={<><Button variant="outline" disabled={busy} onClick={() => setRemoveTarget(null)}>{t("取消", "Cancel")}</Button><Button variant="primary" disabled={disabled} onClick={() => { if (removeTarget) void run(async () => { await onRemove(removeTarget.id); setRemoveTarget(null); }); }}>{t("从列表移除", "Remove from list")}</Button></>}>
      <p>{removeTarget?.title}</p><p>{t("仅从侧栏移除，不删除目录、文件或会话历史。", "Only removes it from the sidebar. Directories, files and session history are not deleted.")}</p>
      {error && <p role="alert">{error}</p>}
    </Modal>
    <Modal open={renameTarget !== null} onClose={() => { if (!busy) setRenameTarget(null); }} title={t("重命名会话", "Rename chat")} closeLabel={t("关闭", "Close")}
      footer={<><Button variant="outline" disabled={busy} onClick={() => setRenameTarget(null)}>{t("取消", "Cancel")}</Button><Button variant="primary" type="submit" form={`${listId}-rename`} disabled={disabled}>{t("保存", "Save")}</Button></>}>
      <form id={`${listId}-rename`} onSubmit={(event) => { event.preventDefault(); if (renameTarget) void run(async () => { await onRenameSession(renameTarget.workspaceId, renameTarget.id, renameTarget.path, renameValue); setRenameTarget(null); }); }}>
        <input className={css.renameInput} aria-label={t("会话名称", "Chat name")} placeholder={t("留空则使用第一条消息", "Leave empty to use the first message")} maxLength={120} ref={renameInput} value={renameValue} onChange={(event) => setRenameValue(event.target.value)} />
      </form>
      {error && <p role="alert">{error}</p>}
    </Modal>
    <Modal open={deleteTarget !== null} onClose={() => { if (!busy) setDeleteTarget(null); }} title={t("删除会话？", "Delete chat?")} closeLabel={t("关闭", "Close")}
      footer={<><Button variant="outline" disabled={busy} onClick={() => setDeleteTarget(null)}>{t("取消", "Cancel")}</Button><Button variant="primary" disabled={disabled || deleteTarget?.running} onClick={() => { if (deleteTarget) void run(async () => { await onDeleteSession(deleteTarget.workspaceId, deleteTarget.id, deleteTarget.path); setDeleteTarget(null); }); }}>{t("删除", "Delete")}</Button></>}>
      <p>{deleteTarget?.name || t("新会话", "New chat")}</p>
      <p>{deleteTarget?.running ? t("Pi 正在运行，请等待当前回复结束后再删除。", "Pi is still working. Wait for the reply to finish before deleting.") : t("会话会从列表中移除，文件移到 Pi 数据目录的 pi-web/trash 中，可手动恢复。项目文件不受影响。", "The chat leaves the list and its file moves to pi-web/trash in the Pi data folder, where you can restore it by hand. Project files are not affected.")}</p>
      {error && <p role="alert">{error}</p>}
    </Modal>
    <DirectoryBrowser open={dialogOpen} busy={busy} listDirectory={listDirectory} createDirectory={createDirectory}
      onOpen={(path) => { void add(path); }} onClose={() => { if (!busy) setDialogOpen(false); }} t={translate} />
    <Modal open={!!addError} onClose={() => setAddError("")} title={t("无法添加工作区", "Could not add workspace")} closeLabel={t("关闭", "Close")}
      footer={<><Button variant="outline" onClick={() => setAddError("")}>{t("取消", "Cancel")}</Button><Button variant="primary" onClick={() => { setAddError(""); void beginPick(); }}>{t("重新选择", "Choose again")}</Button></>}>
      <div role="alert">{addError}</div>
    </Modal>
  </div>;
}
