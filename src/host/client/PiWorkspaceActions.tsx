import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MenuSurface } from "../../../web/src/ui/shared/primitives/MenuSurface.tsx";
import { IconEllipsisOutline16, IconTrashOutline16 } from "../../../web/src/ui/primitives/icons/index.tsx";
import { localize as t } from "../../../web/src/ui/locale/preference.ts";
import css from "./pi-workspaces.module.css";

/** DSH's workspace ellipsis action, limited to the mutation Pi actually supports. */
export function PiWorkspaceActions({ title, active, disabled, open, onOpenChange, onRemove }: {
  title: string;
  active: boolean;
  disabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRemove: () => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const callbacks = useRef({ onOpenChange });
  callbacks.current = { onOpenChange };
  const close = (restoreFocus = true) => {
    onOpenChange(false);
    if (restoreFocus) trigger.current?.focus();
  };
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = trigger.current!.getBoundingClientRect();
    const height = menu.current!.getBoundingClientRect().height;
    setPosition({
      top: Math.max(12, Math.min(anchor.bottom + 4, window.innerHeight - height - 12)),
      left: Math.max(12, Math.min(anchor.right - 220, window.innerWidth - 232)),
    });
    (menu.current?.querySelector<HTMLElement>('button:not(:disabled)') ?? menu.current)?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) callbacks.current.onOpenChange(false);
    };
    const reposition = () => { callbacks.current.onOpenChange(false); trigger.current?.focus(); };
    document.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open]);

  return <>
    <button ref={trigger} type="button" className={css.rowAction} disabled={disabled}
      aria-label={t(`${title} 的工作区操作`, `Workspace actions for ${title}`)} title={t("工作区操作", "Workspace actions")}
      aria-haspopup="menu" aria-expanded={open} onClick={() => open ? close() : onOpenChange(true)}
      onKeyDown={event => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); onOpenChange(true); } }}>
      <IconEllipsisOutline16 />
    </button>
    {open && createPortal(<MenuSurface ref={menu} role="menu" tabIndex={-1} aria-label={t(`${title} 的工作区操作`, `Workspace actions for ${title}`)}
      className={css.menu} style={position}
      onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
        else if (event.key === "Tab") close();
        else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault(); menu.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
        }
      }}>
      <button type="button" role="menuitem" className={css.menuItem} disabled={disabled || active}
        onClick={() => { close(); onRemove(); }}><IconTrashOutline16 />{t("从列表移除工作区", "Remove workspace from list")}</button>
      <p className={css.menuHint}>{active ? t("请先切换到其他工作区再移除", "Switch to another workspace before removing") : t("不删除目录、文件或会话历史", "Keeps directories, files and session history")}</p>
    </MenuSurface>, document.body)}
  </>;
}
