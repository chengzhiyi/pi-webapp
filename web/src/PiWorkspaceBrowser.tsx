import { useEffect, useRef, useState } from "react";
import { IconFolderOpen16, IconPlusOutline16, IconProjectAddOutline16, StateDot } from "./ui/primitives/index.ts";
import { IconChevronDownOutline14, IconCloseFill14, IconSearchOutline16 } from "./ui/primitives/icons/index.tsx";
import { Button } from "./ui/primitives/Button.tsx";
import { Modal } from "./ui/primitives/Modal.tsx";
import { DirectoryBrowser } from "./ui/workspace/DirectoryBrowser.tsx";
import type { DirectoryListing, DirectoryPickerKind, SessionView, WorkspaceListView } from "./pi-bridge.ts";
import browserCss from "./ui/workspace/WorkspaceBrowser.module.css";
import rowsCss from "./ui/workspace/Rows.module.css";
import css from "./pi-workspaces.module.css";

interface Props {
  wide: boolean;
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
const directoryCopy: Record<string, string> = {
  "browser.title": "选择工作区目录", "browser.home": "主目录", "browser.newFolder": "新建文件夹",
  "browser.folderName": "文件夹名称", "browser.createIn": "在\"{name}\"中新建文件夹",
  "browser.untitledFolder": "未命名文件夹", "browser.create": "创建", "browser.cancel": "取消",
  "browser.open": "打开", "browser.editPath": "编辑路径", "browser.loading": "加载中…",
  "browser.truncated": "文件夹过多，仅显示开头部分。", "browser.showHidden": "显示隐藏文件",
};
const translate = (key: string, params?: Record<string, string>) =>
  (directoryCopy[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => params?.[name] ?? "");

export function PiWorkspaceBrowser({ wide, expandSidebar, session, workspaces, onAdd, directoryPickerKind, pickDirectory, listDirectory, createDirectory, onRemove, onSelectSession, onNewSession }: Props) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [addError, setAddError] = useState("");
  const [searchExpanded, setSearchExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (workspaces.activeId) setExpanded((current) => current.has(workspaces.activeId!) ? current : new Set([...current, workspaces.activeId!]));
  }, [workspaces.activeId]);
  const searchInput = useRef<HTMLInputElement>(null);
  const needle = query.trim().toLocaleLowerCase();

  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "操作失败"); }
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

  return <div className={`${browserCss.root} ${!wide ? browserCss.rail : ""}`}>
    <div className={browserCss.sectionHeader}>
      {wide && <span className={`${browserCss.sectionLabel} ${browserCss.wide} ${searchExpanded ? browserCss.sectionLabelHidden : ""}`}>工作区</span>}
      {wide && <div className={`${browserCss.searchSlot} ${searchExpanded ? browserCss.searchSlotExpanded : ""}`}><div className={`${browserCss.search} ${searchExpanded ? browserCss.searchExpanded : ""}`} onClick={() => { setSearchExpanded(true); searchInput.current?.focus(); }}>
        <button type="button" className={browserCss.searchButton} aria-label="搜索工作区和会话" aria-expanded={searchExpanded} onClick={() => { setSearchExpanded(true); searchInput.current?.focus(); }}><IconSearchOutline16 size={searchExpanded ? 11 : 14} /></button>
        <input ref={searchInput} className={browserCss.searchInput} type="search" placeholder="搜索工作区和会话" maxLength={120} value={query} tabIndex={searchExpanded ? 0 : -1} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { setQuery(""); setSearchExpanded(false); } }} />
        {searchExpanded && <button type="button" className={browserCss.clearButton} aria-label="关闭搜索" onClick={(event) => { event.stopPropagation(); setQuery(""); setSearchExpanded(false); }}><IconCloseFill14 /></button>}
      </div></div>}
      <div className={`${browserCss.headerActions} ${wide && searchExpanded ? browserCss.headerActionsHidden : ""}`}>
        <button type="button" className={browserCss.iconButton} aria-label="添加工作区" title="添加工作区" disabled={busy || directoryPickerKind === null} onClick={() => { void beginPick(); }}><IconProjectAddOutline16 size={wide ? 16 : 18} /></button>
      </div>
    </div>
    {wide && <div className={browserCss.listArea}><div className={browserCss.treeBody}><div className={browserCss.list} role="tree" aria-label="工作区">
      {workspaces.items.filter((workspace) => !needle || workspace.title.toLocaleLowerCase().includes(needle) || workspace.path.toLocaleLowerCase().includes(needle) || workspaces.sessions.some((item) => item.workspaceId === workspace.id && item.name.toLocaleLowerCase().includes(needle))).map((workspace) => {
        const active = workspace.id === workspaces.activeId;
        const open = expanded.has(workspace.id) || !!needle;
        return <div key={workspace.id} className={css.group} role="group">
          <div className={css.workspaceLine}>
            <button type="button" className={`${rowsCss.projectRow} ${css.workspaceButton} ${active ? css.active : ""}`} role="treeitem" aria-expanded={open} title={workspace.path} disabled={busy} onClick={() => setExpanded((current) => { const next = new Set(current); if (next.has(workspace.id)) next.delete(workspace.id); else next.add(workspace.id); return next; })}>
              <span className={rowsCss.slot}><span className={css.folder}><IconFolderOpen16 size={16} /></span><span className={`${css.chevron} ${open ? css.chevronOpen : ""}`}><IconChevronDownOutline14 size={14} /></span></span><span className={rowsCss.title}>{workspace.title}</span>
            </button>
            <button type="button" className={css.rowAction} title="新建会话" aria-label={`在 ${workspace.title} 新建会话`} disabled={busy} onClick={() => { void run(() => onNewSession(workspace.id)); }}><IconPlusOutline16 size={16} /></button>
            {!active && <button type="button" className={css.rowAction} title="从列表移除工作区" aria-label={`移除 ${workspace.title}`} disabled={busy} onClick={() => { void run(() => onRemove(workspace.id)); }}>×</button>}
          </div>
          {open && workspaces.sessions.filter((item) => item.workspaceId === workspace.id && (!needle || workspace.title.toLocaleLowerCase().includes(needle) || workspace.path.toLocaleLowerCase().includes(needle) || item.name.toLocaleLowerCase().includes(needle))).map((item) => <button key={item.id} type="button" className={`${rowsCss.sessionRow} ${css.sessionButton} ${active && session?.sessionId === item.id ? rowsCss.selected : ""}`} role="treeitem" aria-current={active && session?.sessionId === item.id ? "page" : undefined} disabled={busy} onClick={() => { void run(() => onSelectSession(workspace.id, item.id, item.path)); }}>
            <span className={rowsCss.slot}><StateDot state={session?.sessionId === item.id && !session.idle ? "ongoing" : "done"} /></span><span className={rowsCss.title}>{item.name}</span>
          </button>)}
        </div>;
      })}
      {error && !dialogOpen && <p className={css.error} role="alert">{error}</p>}
    </div></div></div>}
    <DirectoryBrowser open={dialogOpen} busy={busy} listDirectory={listDirectory} createDirectory={createDirectory}
      onOpen={(path) => { void add(path); }} onClose={() => { if (!busy) setDialogOpen(false); }} t={translate} />
    <Modal open={!!addError} onClose={() => setAddError("")} title="无法添加工作区" closeLabel="关闭"
      footer={<><Button variant="outline" onClick={() => setAddError("")}>取消</Button><Button variant="primary" onClick={() => { setAddError(""); void beginPick(); }}>重新选择</Button></>}>
      <div role="alert">{addError}</div>
    </Modal>
  </div>;
}
