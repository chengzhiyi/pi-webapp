import { useEffect, useRef, useState } from "react";
import { useLocale, setLocalePreference, type Locale } from "../locale/preference.ts";
import css from "./LanguageRow.module.css";

const options: readonly { id: Locale; label: string }[] = [
  { id: "zh", label: "中文" },
  { id: "en", label: "English" },
];

export function LanguageRow() {
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const selected = useRef<HTMLButtonElement>(null);

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

  const select = (next: Locale) => {
    setLocalePreference(next);
    setOpen(false);
    trigger.current?.focus();
  };

  return <div className={css.row} ref={root}>
    <div className={css.title}>{locale === "zh" ? "语言" : "Language"}</div>
    <div className={css.selectorWrap}>
      <button ref={trigger} type="button" className={css.selector} aria-label={locale === "zh" ? "语言" : "Language"} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {options.find((option) => option.id === locale)?.label}
        <svg className={css.chevron} width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="m3.5 5.25 3.5 3.5 3.5-3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && <div className={css.menu} role="menu" aria-label={locale === "zh" ? "选择语言" : "Choose language"} onKeyDown={(event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        const current = options.findIndex((option) => option.id === (document.activeElement as HTMLElement)?.dataset.locale);
        const next = options[(current + (event.key === "ArrowDown" ? 1 : options.length - 1)) % options.length];
        root.current?.querySelector<HTMLButtonElement>(`[data-locale="${next.id}"]`)?.focus();
      }}>
        {options.map((option) => <button key={option.id} ref={option.id === locale ? selected : undefined} type="button" role="menuitemradio" aria-checked={option.id === locale} data-locale={option.id} className={css.option} onClick={() => select(option.id)}>
          <span>{option.label}</span>{option.id === locale && <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m3 8 3.2 3.2L13 4.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>}
        </button>)}
      </div>}
    </div>
  </div>;
}
