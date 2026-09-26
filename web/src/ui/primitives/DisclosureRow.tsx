import type { KeyboardEvent, ReactNode } from "react";
import { IconChevronDownOutline14 } from "./icons/index.tsx";
import css from "./DisclosureRow.module.css";

interface Props {
  icon: ReactNode;
  title: string;
  open: boolean;
  onToggle: () => void;
  collapsedContent?: ReactNode;
  children?: ReactNode;
  rowClassName?: string;
  leadingClassName?: string;
  titleClassName?: string;
  chevronClassName?: string;
}

/** Compact, full-row keyboard-accessible disclosure. */
export function DisclosureRow({ icon, title, open, onToggle, collapsedContent, children, rowClassName, leadingClassName, titleClassName, chevronClassName }: Props) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onToggle();
  };
  return <div className={css.root} data-open={open || undefined}>
    <div className={`${css.row} ${rowClassName ?? ""}`} data-disclosure-row data-expandable role="button" tabIndex={0} aria-expanded={open} onClick={onToggle} onKeyDown={onKeyDown}>
      <span className={`${css.leading} ${leadingClassName ?? ""}`}>
        {open ? <IconChevronDownOutline14 className={chevronClassName} /> : <><span className={css.iconIdle}>{icon}</span><IconChevronDownOutline14 className={`${css.chevronHover} ${chevronClassName ?? ""}`} /></>}
      </span>
      <span className={`${css.title} ${titleClassName ?? ""}`}>{title}</span>
      {!open && collapsedContent}
    </div>
    {open && children}
  </div>;
}
