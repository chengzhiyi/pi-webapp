import { useEffect, useId, useRef, useState } from "react";
import css from "./SettingsSelect.module.css";

interface SettingsSelectProps<T extends string> {
  label: string;
  menuLabel: string;
  value: T;
  options: readonly { id: T; label: string }[];
  disabled?: boolean;
  onChange: (value: T) => void;
}

/** Shared settings picker so language and update preferences behave alike. */
export function SettingsSelect<T extends string>({ label, menuLabel, value, options, disabled, onChange }: SettingsSelectProps<T>) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const selected = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open) return;
    selected.current?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return <div className={css.selectorWrap} ref={root} onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
  }}>
    <button ref={trigger} type="button" className={css.selector} aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} disabled={disabled} onClick={() => setOpen((value) => !value)}>
      <span className={css.value}>{options.find((option) => option.id === value)?.label}</span>
      <svg className={css.chevron} width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="m3.5 5.25 3.5 3.5 3.5-3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </button>
    {open && <div id={menuId} className={css.menu} role="menu" aria-label={menuLabel} onKeyDown={(event) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
      items[next]?.focus();
    }}>
      {options.map((option) => <button key={option.id} ref={option.id === value ? selected : undefined} type="button" role="menuitemradio" aria-checked={option.id === value} className={css.option} onClick={() => {
        setOpen(false);
        trigger.current?.focus();
        if (option.id !== value) onChange(option.id);
      }}>
        <span>{option.label}</span>{option.id === value && <svg className={css.chevron} width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m3 8 3.2 3.2L13 4.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>}
      </button>)}
    </div>}
  </div>;
}
