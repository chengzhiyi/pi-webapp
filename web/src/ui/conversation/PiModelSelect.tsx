import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { IconCheckOutline16, IconChevronDownOutline14, IconChevronRightOutline14, IconDataOutline16 } from "../primitives/icons/index.tsx";
import type { ModelOption } from "../../pi-bridge.ts";
import css from "./ModelSelect.module.css";
import { localize as t } from "../locale/preference.ts";

interface Props {
  openSignal?: number;
  current: string | null;
  models: ModelOption[];
  disabled: boolean;
  onSelect: (provider: string, id: string) => Promise<void>;
  thinkingLevel: string | null;
  thinkingLevels: string[];
  onSelectThinkingLevel: (level: string) => Promise<void>;
}

/** Model picker backed by Pi's available-model directory. */
export function PiModelSelect({ openSignal = 0, current, models, disabled, onSelect, thinkingLevel, thinkingLevels, onSelectThinkingLevel }: Props) {
  const effortNames: Record<string, string> = { off: t("关闭", "Off"), minimal: t("极低", "Minimal"), low: t("低", "Low"), medium: t("中", "Medium"), high: t("高", "High"), xhigh: t("极高", "Extra high") };
  const [open, setOpen] = useState(false);
  const lastOpenSignal = useRef(openSignal);
  useEffect(() => {
    if (openSignal === lastOpenSignal.current) return;
    lastOpenSignal.current = openSignal;
    if (!disabled) setOpen(true);
  }, [openSignal, disabled]);
  const [pane, setPane] = useState<"root" | "model" | "effort">("root");
  const [busy, setBusy] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({ visibility: "hidden", left: 0, top: 0 });
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const groups = useMemo(() => {
    const grouped = new Map<string, ModelOption[]>();
    for (const model of models) grouped.set(model.provider, [...(grouped.get(model.provider) ?? []), model]);
    return [...grouped];
  }, [models]);
  const selected = models.find((model) => `${model.provider}/${model.id}` === current);
  const label = selected?.name || current || t("Pi 模型", "Pi model");
  const effortLabel = thinkingLevels.length > 1 && thinkingLevel ? effortNames[thinkingLevel] ?? thinkingLevel : null;

  const close = (restoreFocus = false) => {
    setOpen(false);
    setPane("root");
    if (restoreFocus) triggerRef.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node) && !menuRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [open]);
  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !menuRef.current) return;
    const place = () => {
      if (!triggerRef.current || !menuRef.current) return;
      const anchor = triggerRef.current.getBoundingClientRect();
      const menu = menuRef.current.getBoundingClientRect();
      const left = Math.max(16, Math.min(anchor.right - menu.width, innerWidth - menu.width - 16));
      const top = anchor.top - menu.height - 8 >= 16 ? anchor.top - menu.height - 8 : Math.min(anchor.bottom + 8, innerHeight - menu.height - 16);
      setPosition({ left, top });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open, pane, models.length]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { event.preventDefault(); if (pane === "root") close(true); else setPane("root"); return; }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button[role^="menuitem"]') ?? [])].filter((item) => !item.disabled);
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  };
  const choose = async (model: ModelOption) => {
    if (`${model.provider}/${model.id}` === current) { close(true); return; }
    setBusy(true);
    try { await onSelect(model.provider, model.id); close(true); }
    catch { /* The Pi bridge displays the request error beside the composer. */ }
    finally { setBusy(false); }
  };
  const chooseEffort = async (level: string) => {
    if (level === thinkingLevel) { close(true); return; }
    setBusy(true);
    try { await onSelectThinkingLevel(level); close(true); }
    catch { /* The Pi bridge displays the request error beside the composer. */ }
    finally { setBusy(false); }
  };

  return <div ref={rootRef} className={css.root} onKeyDown={onKeyDown}>
    <button ref={triggerRef} className={css.trigger} type="button" aria-label={t(`切换模型，当前 ${label}${effortLabel ? `，推理强度${effortLabel}` : ""}`, `Change model, current ${label}${effortLabel ? `, reasoning effort ${effortLabel}` : ""}`)} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? `${id}-menu` : undefined} title={effortLabel ? `${label} · ${effortLabel}` : label} disabled={disabled || busy} onClick={() => open ? close() : setOpen(true)}>
      <IconDataOutline16 className={css.triggerIcon} size={16} />
      <span className={css.triggerLabel}>{label}</span>
      {effortLabel && <span className={css.triggerEffort}>{effortLabel}</span>}
      <IconChevronDownOutline14 className={`${css.chevron} ${open ? css.chevronOpen : ""}`} />
    </button>
    {open && createPortal(<div ref={menuRef} id={`${id}-menu`} role="menu" aria-label={t("选择模型", "Choose model")} className={css.menu} style={position}>
      {pane === "root" ? <><button type="button" role="menuitem" className={css.cell} onClick={() => setPane("model")}><span className={css.cellLabel}>{t("模型", "Model")}</span><span className={css.cellValue}>{label}</span><IconChevronRightOutline14 className={css.cellChevron} /></button>{effortLabel && <button type="button" role="menuitem" className={css.cell} onClick={() => setPane("effort")}><span className={css.cellLabel}>{t("推理强度", "Reasoning effort")}</span><span className={css.cellValue}>{effortLabel}</span><IconChevronRightOutline14 className={css.cellChevron} /></button>}</> : pane === "model" ? <>
        <div className={css.groups}>
          {groups.map(([provider, options]) => <section className={css.group} role="group" aria-label={provider} key={provider}>
            <div className={css.groupTitle}>{provider}</div>
            {options?.map((model) => <button key={model.id} type="button" role="menuitemradio" aria-checked={`${model.provider}/${model.id}` === current} className={`${css.option} ${`${model.provider}/${model.id}` === current ? css.selected : ""}`} title={model.name || model.id} disabled={busy} onClick={() => { void choose(model); }}><span className={css.optionCopy}><span className={css.modelName}>{model.name || model.id}</span></span><span className={css.check}>{`${model.provider}/${model.id}` === current && <IconCheckOutline16 />}</span></button>)}
          </section>)}
        </div>
        {models.length === 0 && <div className={css.empty}>{t("暂无可用模型", "No models available")}</div>}
      </> : <div className={css.groups}>{thinkingLevels.map((level) => <button key={level} type="button" role="menuitemradio" aria-checked={level === thinkingLevel} className={`${css.option} ${level === thinkingLevel ? css.selected : ""}`} disabled={busy} onClick={() => { void chooseEffort(level); }}><span className={css.optionCopy}><span className={css.modelName}>{effortNames[level] ?? level}</span></span><span className={css.check}>{level === thinkingLevel && <IconCheckOutline16 />}</span></button>)}</div>}
    </div>, document.body)}
  </div>;
}
