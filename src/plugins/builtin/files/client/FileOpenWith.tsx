import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fileManagerError, fileManagerLabel, getDesktopOpenWith, type SessionFileTarget, type SystemFileApp } from "../../../../host/client/desktop-file-manager.ts";
import { IconChevronDownOutline14, IconFolderOpenOutline16 } from "../../../../../web/src/ui/primitives/icons/index.tsx";
import { MenuSurface } from "../../../../../web/src/ui/shared/primitives/MenuSurface.tsx";
import { localize as t } from "../../../../../web/src/ui/locale/preference.ts";
import css from "../../../../../web/src/ui/workbench/WorkspacePanel.module.css";

const managerId = "file-manager";
function preferenceKey({ kind, path }: SessionFileTarget) {
  const name = path.split("/").at(-1) ?? "";
  const ext = name.lastIndexOf(".");
  return `pi-web-open-with:${kind === "directory" ? "directory" : `file:${ext > 0 ? name.slice(ext).toLowerCase() : ""}`}`;
}
function preferred(key: string) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function AppIcon({ app }: { app: SystemFileApp }) {
  if (app.icon) return <img className={css.openWithIcon} src={app.icon} alt="" />;
  if (app.id === managerId) return <IconFolderOpenOutline16 className={css.openWithIcon} />;
  return <span aria-hidden="true" className={`${css.openWithIcon} ${css.openWithInitial}`}>{Array.from(app.name)[0]}</span>;
}

export function FileOpenWith({ sessionId, path, kind }: SessionFileTarget) {
  const bridge = getDesktopOpenWith();
  if (!bridge) return null;
  return <OpenWith key={JSON.stringify([sessionId, path, kind])} target={{ sessionId, path, kind }} bridge={bridge} />;
}

function OpenWith({ target, bridge }: { target: SessionFileTarget; bridge: NonNullable<ReturnType<typeof getDesktopOpenWith>> }) {
  const { sessionId, path, kind } = target;
  const key = preferenceKey(target);
  const [remembered, setRemembered] = useState(() => preferred(key));
  const [apps, setApps] = useState<SystemFileApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [opening, setOpening] = useState(false);
  const [open, setOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const anchor = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const { listApps } = bridge;
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(false);
    void listApps({ sessionId, path, kind }).then(result => {
      if (!cancelled) { setApps(result.ok ? result.apps : []); setError(!result.ok); }
    }).catch(() => { if (!cancelled) { setApps([]); setError(true); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [listApps, sessionId, path, kind, refresh]);

  const manager: SystemFileApp = { id: managerId, name: fileManagerLabel(bridge.platform, kind) };
  const options = [...apps, manager];
  const selected = options.find(app => app.id === remembered)
    ?? (kind === "directory" ? manager : apps.find(app => app.isDefault) ?? manager);
  const launch = async () => {
    if (opening) return;
    setOpening(true);
    try {
      const result = selected.id === managerId ? await bridge.show(target) : await bridge.openWith(target, selected.id);
      if (!result.ok) { fileManagerError(result.reason, true); setRefresh(value => value + 1); }
    } catch { fileManagerError("failed", true); }
    finally { setOpening(false); }
  };
  const close = () => { setOpen(false); trigger.current?.focus({ preventScroll: true }); };
  const choose = (id: string) => {
    setRemembered(id);
    try { localStorage.setItem(key, id); } catch { /* Storage can be disabled. */ }
    close();
  };
  const itemButtons = () => [...(menu.current?.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]") ?? [])];
  useLayoutEffect(() => {
    if (!open || !anchor.current || !menu.current) return;
    const place = () => {
      const bounds = anchor.current?.getBoundingClientRect();
      const surface = menu.current;
      if (!bounds || !surface) return;
      const below = bounds.bottom + 4;
      const height = surface.offsetHeight;
      setPosition({ left: Math.max(8, Math.min(bounds.right - surface.offsetWidth, window.innerWidth - surface.offsetWidth - 8)),
        top: below + height > window.innerHeight - 8 ? Math.max(8, bounds.top - height - 4) : below });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(menu.current);
    (menu.current.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? menu.current)?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !anchor.current?.contains(event.target as Node)) setOpen(false);
    };
    const resize = () => { setOpen(false); trigger.current?.focus({ preventScroll: true }); };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", resize);
    return () => { observer.disconnect(); document.removeEventListener("pointerdown", outside, true); window.removeEventListener("resize", resize); };
  }, [open]);

  const pickerLabel = t("选择打开方式", "Choose an app to open with");
  const openLabel = t("打开", "Open");
  return <div ref={anchor} className={css.openWith} aria-busy={loading || opening}>
    <button type="button" className={`${css.textButton} ${css.openWithMain}`} aria-label={selected.id === managerId
      ? selected.name : t(`用 ${selected.name} 打开`, `Open with ${selected.name}`)} title={selected.name}
      disabled={opening || (loading && (kind === "file" || !!remembered))} onClick={() => { setOpen(false); void launch(); }}>
      <AppIcon app={selected} /><span className={css.openWithText}>{openLabel}</span>
    </button>
    <button ref={trigger} type="button" className={`${css.iconButton} ${css.openWithChevron}`} aria-label={pickerLabel} title={pickerLabel}
      aria-haspopup="menu" aria-expanded={open} onClick={() => open ? close() : setOpen(true)}
      onKeyDown={event => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); } }}>
      <IconChevronDownOutline14 />
    </button>
    {open && createPortal(<MenuSurface ref={menu} role="menu" tabIndex={-1} aria-label={pickerLabel} className={`${css.fileMenu} ${css.openWithMenu}`} style={position}
      onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
        else if (event.key === "Tab") close();
        else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault(); event.stopPropagation();
          const items = itemButtons();
          const index = items.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
            : event.key === "ArrowUp" ? (index <= 0 ? items.length - 1 : index - 1) : (index + 1) % items.length;
          items[next]?.focus();
        }
      }}>
      <div className={css.openWithMenuBody}>
        {loading && <p className={css.openWithHint} role="status">{t("正在查找可用应用…", "Finding installed apps…")}</p>}
        {error && <p className={css.openWithHint} role="status">{t("未能读取系统应用", "Could not load system apps")}</p>}
        {options.map(app => <div key={app.id} role="none">
          {app.id === managerId && apps.length > 0 && <div role="separator" className={css.openWithSeparator} />}
          <button type="button" role="menuitemradio" tabIndex={-1} aria-checked={selected.id === app.id} className={css.fileMenuItem} onClick={() => choose(app.id)}>
            <AppIcon app={app} /><span className={css.openWithName}>{app.name}</span>
            {app.isDefault && <span className={css.openWithDefault}>{t("默认", "Default")}</span>}
            <span className={css.openWithCheck} aria-hidden="true">{selected.id === app.id ? "✓" : ""}</span>
          </button>
        </div>)}
      </div>
    </MenuSurface>, document.body)}
  </div>;
}
