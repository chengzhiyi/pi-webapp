import { useEffect, useId, useState } from "react";
import type { SessionView } from "../../contracts/bridge-contract.ts";
import { displayUserMessage } from "../../contracts/user-message.ts";
import { localize as t } from "../../../web/src/ui/locale/preference.ts";
import { IconChevronDownOutlineRegular, IconChevronUpOutlineRegular, IconQueueOutlineRegular } from "../../../web/src/ui/shared/primitives/icons/index.tsx";
import { FileTypeIcon } from "../../../web/src/ui/primitives/FileTypeIcon.tsx";
import css from "./PiPromptQueue.module.css";

/** DSH-style attached dock over Pi's read-only native queue, not a second queue. */
export function PiPromptQueue({ session }: { session: SessionView | null }) {
  const [collapsed, setCollapsed] = useState(true);
  const listId = useId();
  const queue = session?.promptQueue;
  const entries = [
    ...(queue?.steering ?? []).map(text => ({ label: t("引导", "Steer"), text })),
    ...(queue?.followUp ?? []).map(text => ({ label: t("排队", "Queue"), text })),
  ];
  useEffect(() => { setCollapsed(true); }, [session?.sessionId]);
  useEffect(() => { if (entries.length === 0) setCollapsed(true); }, [entries.length]);
  if (!entries.length && !session?.hasPendingPrompts) return null;
  const listVisible = entries.length === 1 || !collapsed;
  const count = t(`${entries.length} 条待处理提示词`, `${entries.length} pending prompts`);
  return <section className={css.dock} aria-label={t("待处理提示词", "Pending prompts")} data-queue-dock="">
    <div className={css.panel}>
      {entries.length > 1 && <button type="button" className={css.header} aria-controls={listId} aria-expanded={listVisible} onClick={() => setCollapsed(value => !value)}>
        <span className={css.lead} aria-hidden><IconQueueOutlineRegular /></span>
        <span className={css.count} role="status">{count}</span>
        <span className={css.chevron} aria-hidden>{listVisible ? <IconChevronDownOutlineRegular /> : <IconChevronUpOutlineRegular />}</span>
      </button>}
      {entries.length === 0 && <div className={css.header}><span className={css.lead} aria-hidden><IconQueueOutlineRegular /></span><span className={css.count} role="status">{t("等待 Pi 接收", "Waiting for Pi")}</span></div>}
      <ol id={listId} className={css.list} hidden={!listVisible}>{entries.map((entry, index) => {
        const displayed = displayUserMessage(entry.text);
        return <li key={index} className={css.row}>
          {entries.length === 1 && <span className={css.lead} aria-hidden><IconQueueOutlineRegular /></span>}
          <span className={css.kind}>{entry.label}</span>
          {displayed.attachments.length > 0 && <span className={css.attachments}>{displayed.attachments.map((file, ordinal) => <span key={ordinal} className={css.file} title={file.name}><FileTypeIcon path={file.name} /><span>{file.name}</span></span>)}</span>}
          {displayed.text && <span className={css.preview} title={displayed.text}>{displayed.text}</span>}
        </li>;
      })}</ol>
      {session?.paused && <div className={css.paused} role="status">{t("已暂停，继续后处理", "Paused; processed on resume")}</div>}
    </div>
  </section>;
}
