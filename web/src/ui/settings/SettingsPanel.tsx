/** Settings panel with Pi-owned section content. */
import { useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";
import { IconArchiveOutline20, IconCloseOutline16, IconDataOutline16, IconPersonalizationOutline16, IconSettingsOutline16, IconSkillOutline16 } from "../primitives/icons/index.tsx";
import css from "../SettingsRoot.module.css";

export interface SettingsSection {
  id: string;
  label: string;
}

function navIcon(id: string) {
  if (id === "general") return <IconSettingsOutline16 className={css.navIcon} size={16} />;
  if (id === "models") return <IconDataOutline16 className={css.navIcon} size={16} />;
  if (id === "packages") return <IconArchiveOutline20 className={css.navIcon} size={16} />;
  if (id === "extensions") return <IconPersonalizationOutline16 className={css.navIcon} size={16} />;
  return <IconSkillOutline16 className={css.navIcon} size={16} />;
}

interface Props {
  title: string;
  sections: readonly SettingsSection[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: () => void;
  children: ReactNode;
}

export function SettingsPanel({ title, sections, activeId, onSelect, onClose, children }: Props) {
  const titleId = useId();
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return <div className={css.overlay} role="presentation">
    <div className={css.mask} aria-hidden="true" onClick={onClose} />
    <div className={css.panel} role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <nav className={css.nav} aria-label="Pi 设置分类">
        <div className={css.navTitle} id={titleId}>{title}</div>
        <div className={css.navList}>{sections.map((section) => <button
          key={section.id}
          type="button"
          className={`${css.navCell} ${activeId === section.id ? css.active : ""}`}
          aria-current={activeId === section.id ? "true" : undefined}
          onClick={() => onSelect(section.id)}
        >{navIcon(section.id)}<span className={css.navLabel}>{section.label}</span></button>)}</div>
      </nav>
      <div className={css.content}>
        <header className={css.header}>
          <div className={css.actions} />
          <button ref={closeButton} className={css.close} type="button" onClick={onClose} aria-label="关闭 Pi 设置"><IconCloseOutline16 size={14} /></button>
        </header>
        <div className={css.options}>{children}</div>
      </div>
    </div>
  </div>;
}
