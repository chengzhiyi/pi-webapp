import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MenuSurface } from "../../../web/src/ui/shared/primitives/MenuSurface.tsx";
import { Tooltip } from "../../../web/src/ui/primitives/Tooltip.tsx";
import { IconQuestionOutline14 } from "../../../web/src/ui/primitives/icons/index.tsx";
import { useLocale, textFor } from "../../../web/src/ui/locale/preference.ts";
import { helpLinks } from "../../../web/src/ui/settings/help-links.ts";
import rows from "./pi-workspaces.module.css";
import css from "./PiHelpMenu.module.css";

/** Sidebar-foot help button; the menu opens upward toward the conversation list. */
export function PiHelpMenu({ wide }: { wide: boolean }) {
  const locale = useLocale();
  const t = (zh: string, en: string) => textFor(locale, zh, en);
  const label = t("帮助与文档", "Help & documentation");
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const close = (restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  };
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = trigger.current!.getBoundingClientRect();
    const { height, width } = menu.current!.getBoundingClientRect();
    setPosition({
      top: Math.max(12, anchor.top - height - 4),
      left: Math.max(12, Math.min(wide ? anchor.right - width : anchor.left, window.innerWidth - width - 12)),
    });
    menu.current?.querySelector<HTMLElement>("a")?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false);
    };
    const reposition = () => { setOpen(false); trigger.current?.focus(); };
    document.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("resize", reposition);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("resize", reposition);
    };
  }, [open, wide]);

  return <>
    <Tooltip label={label} disabled={open}>
      <button ref={trigger} type="button" className={`pi-settings-sidebar ${css.trigger}`} data-wide={wide}
        aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => open ? close() : setOpen(true)}
        onKeyDown={event => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); } }}>
        <IconQuestionOutline14 size={wide ? 16 : 18} />
      </button>
    </Tooltip>
    {open && createPortal(<MenuSurface ref={menu} role="menu" tabIndex={-1} aria-label={label}
      className={rows.menu} style={position}
      onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
        else if (event.key === "Tab") close();
        else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          const items = [...menu.current?.querySelectorAll<HTMLElement>("a") ?? []];
          const index = items.indexOf(document.activeElement as HTMLElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : event.key === "ArrowDown" ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
          items[next]?.focus();
        }
      }}>
      {helpLinks(locale).map(link => <a key={link.id} role="menuitem" href={link.href} target="_blank" rel="noreferrer"
        className={`${rows.menuItem} ${rows.menuItemNeutral} ${css.item}`} onClick={() => close(false)}>{link.label}</a>)}
    </MenuSurface>, document.body)}
  </>;
}
