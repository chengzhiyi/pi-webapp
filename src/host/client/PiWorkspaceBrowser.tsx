import { useEffect, useId, useRef, useState } from "react";
import { IconFolderOpen16, IconProjectAddOutline16, StateDot } from "../../../web/src/ui/primitives/index.ts";
import { IconChevronDownOutline14, IconCloseFill14, IconSearchOutline16, IconFolderClose16, IconNewChatOutline16 } from "../../../web/src/ui/primitives/icons/index.tsx";
import { Button } from "../../../web/src/ui/primitives/Button.tsx";
import { Modal } from "../../../web/src/ui/primitives/Modal.tsx";
import { PiWorkspaceActions } from "./PiWorkspaceActions.tsx";
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
  workspaces: WorkspaceListView;
  onAdd: (path: string, create: boolean) => Promise<void>;
  directoryPickerKind: DirectoryPickerKind | null;
  pickDirectory: () => Promise<string | null>;
  listDirectory: (path?: string, signal?: AbortSignal) => Promise<DirectoryListing>;
  createDirectory: (path: string, name: string) => Promise<string>;
  onRemove: (id: string) => Promise<void>;
  onSelectSession: (workspaceId: string, id: string, path: string | null) => Promise<void>;
  onNewSession: (workspaceId: string) => Promise<void>;
}

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

export function PiWorkspaceBrowser({ wide, navigationBusy = false, connected = true, expandSidebar, session, workspaces, onAdd, directoryPickerKind, pickDirectory, listDirectory, createDirectory, onRemove, onSelectSession, onNewSession }: Props) {
  const locale = useLocale();
  const [now, setNow] = useState(Date.now);
  const [workspaceMenuId, setWorkspaceMenuId] = useState<string | null>(null);
  useEffect(() => {
    if (!wide) { setWorkspaceMenuId(null); return; }
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
  useEffect(() => {
    root.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: "nearest" });
  }, [wide, session?.sessionId, expanded]);
  const searchButton = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const needle = query.trim().toLocaleLowerCase();

  const closeSearch = () => {
    setQuery(""); setSearchExpanded(false); searchButton.current?.focus();
  };
  const matchingWorkspaces = workspaces.items.filter((workspace) => !needle || workspace.title.toLocaleLowerCase().includes(needle) || workspace.path.toLocaleLowerCase().includes(needle) || workspaces.sessions.some((item) => item.workspaceId === workspace.id && item.name.toLocaleLowerCase().includes(needle)));
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
        const open = expanded.has(workspace.id) || !!needle;
        return <div key={workspace.id} className={css.group} role="listitem">
          <div className={css.workspaceLine} data-menu-open={workspaceMenuId === workspace.id || undefined}>
            <button type="button" className={`${rowsCss.projectRow} ${css.workspaceButton}`} aria-expanded={open} aria-controls={`${listId}-${workspace.id}`} title={workspace.path} disabled={busy} onClick={() => setExpanded((current) => { const next = new Set(current); if (next.has(workspace.id)) next.delete(workspace.id); else next.add(workspace.id); return next; })}>
              <span className={rowsCss.slot} aria-hidden="true"><span data-workspace-leading="folder" className={`${css.folder} ${active ? css.folderActive : ""}`}>{open ? <IconFolderOpen16 size={16} /> : <IconFolderClose16 size={16} />}</span><span data-workspace-leading="chevron" className={`${css.chevron} ${open ? css.chevronOpen : ""}`}><IconChevronDownOutline14 size={14} /></span></span><span className={`${rowsCss.title} ${css.workspaceTitle}`}>{workspace.title}</span>
              {unavailable && <span className={css.unavailable}>{t("不可用", "Unavailable")}</span>}
            </button>
            <span className={css.rowActions} data-workspace-actions>
              <PiWorkspaceActions title={workspace.title} active={active} disabled={disabled} open={workspaceMenuId === workspace.id}
                onOpenChange={open => setWorkspaceMenuId(open ? workspace.id : null)} onRemove={() => { setError(""); setRemoveTarget({ id: workspace.id, title: workspace.title }); }} />
              <button type="button" className={css.rowAction} title={unavailable ? t("目录不可用，请恢复目录或移除后重新添加", "Directory unavailable; restore it or remove and add the workspace again") : t("新建会话", "New session")} aria-label={t(`在 ${workspace.title} 新建会话`, `Create a session in ${workspace.title}`)} disabled={disabled || unavailable} onClick={() => { void run(async () => { await onNewSession(workspace.id); setQuery(""); setExpanded(current => new Set([...current, workspace.id])); }); }}><IconNewChatOutline16 size={16} /></button>
            </span>
          </div>
          <div id={`${listId}-${workspace.id}`} role="group" aria-label={workspace.title} hidden={!open}>
          {open && workspaces.sessions.filter((item) => item.workspaceId === workspace.id && (!needle || workspace.title.toLocaleLowerCase().includes(needle) || workspace.path.toLocaleLowerCase().includes(needle) || item.name.toLocaleLowerCase().includes(needle))).map((item) => <button key={item.id} type="button" className={`${rowsCss.sessionRow} ${css.sessionButton} ${active && session?.sessionId === item.id ? rowsCss.selected : ""}`} title={item.name} aria-label={item.name} aria-describedby={`${listId}-${item.id}-status`} aria-current={active && session?.sessionId === item.id ? "page" : undefined} disabled={disabled || unavailable} onClick={() => { void run(() => onSelectSession(workspace.id, item.id, item.path)); }}>
            <span className={rowsCss.slot}>{(session?.sessionId === item.id ? !session.idle : item.idle === false) && <StateDot state="ongoing" />}</span><span className={rowsCss.title}>{item.name}</span>
            <time className={css.sessionTime} dateTime={item.modified} title={item.modified}>{sessionTimeLabel(item.modified, now, locale)}</time>
            <span id={`${listId}-${item.id}-status`} className={rowsCss.visuallyHidden}>{(session?.sessionId === item.id ? !session.idle : item.idle === false) ? t("运行中", "Running") : t("空闲", "Idle")}</span>
          </button>)}
          {open && !needle && !workspaces.sessions.some(item => item.workspaceId === workspace.id) && <p className={browserCss.empty}>{t("还没有会话，创建新会话开始", "No sessions yet. Create a session to start.")}</p>}
          </div>
        </div>;
      })}
      {matchingWorkspaces.length === 0 && <p className={browserCss.empty} role="status">{needle ? t("没有找到匹配的工作区或会话", "No matching workspaces or sessions") : t("添加工作区，开始管理对话", "Add a workspace to start organizing conversations")}{needle && <button type="button" className={browserCss.sessionOverflowButton} onClick={closeSearch}>{t("清除搜索", "Clear search")}</button>}</p>}
      {busy && <p className={browserCss.searchStatus} role="status">{t("正在处理…", "Working…")}</p>}
      {error && !dialogOpen && <p className={css.error} role="alert">{error}</p>}
    </div></div></div>}
    <Modal open={removeTarget !== null} onClose={() => { if (!busy) setRemoveTarget(null); }} title={t("移除工作区？", "Remove workspace?")} closeLabel={t("关闭", "Close")}
      footer={<><Button variant="outline" disabled={busy} onClick={() => setRemoveTarget(null)}>{t("取消", "Cancel")}</Button><Button variant="primary" disabled={disabled} onClick={() => { if (removeTarget) void run(async () => { await onRemove(removeTarget.id); setRemoveTarget(null); }); }}>{t("从列表移除", "Remove from list")}</Button></>}>
      <p>{removeTarget?.title}</p><p>{t("仅从侧栏移除，不删除目录、文件或会话历史。", "Only removes it from the sidebar. Directories, files and session history are not deleted.")}</p>
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
