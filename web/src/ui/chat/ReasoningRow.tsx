import { useState } from "react";
import { DisclosureRow } from "../primitives/DisclosureRow.tsx";
import { IconThinkOutline14 } from "../primitives/icons/index.tsx";
import css from "./ReasoningRow.module.css";
import { localize as t } from "../locale/preference.ts";

/** Pi thinking content displayed in a collapsible row. */
export function ReasoningRow({ text, running }: { text: string; running: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const visible = text.trimEnd();
  const summary = (running ? visible.slice(visible.lastIndexOf("\n") + 1) : text.split("\n", 1)[0]).replaceAll("**", "");
  return <div className={css.root} data-variant="think" data-state={running ? "running" : "ok"} data-expanded={expanded || undefined}>
    <DisclosureRow icon={<IconThinkOutline14 size={14} />} title={t("思考", "Thinking")} open={expanded} onToggle={() => setExpanded((value) => !value)} rowClassName={css.row} leadingClassName={css.leading} titleClassName={css.title} chevronClassName={css.chevron} collapsedContent={<><span className={css.separator} aria-hidden /><span className={css.summary} data-follow-end={running || undefined}><span className={css.summaryText}>{summary}</span></span></>}>
      <div className={css.thinkBody}>{text}</div>
    </DisclosureRow>
  </div>;
}
