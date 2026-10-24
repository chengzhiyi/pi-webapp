import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { QueuedPrompt, QueuedPromptAction, SessionView } from "../../contracts/bridge-contract.ts";
import { displayUserMessage } from "../../contracts/user-message.ts";
import { localize as t } from "../../../web/src/ui/locale/preference.ts";
import { IconChevronDownOutlineRegular, IconChevronUpOutlineRegular, IconQueueOutlineRegular, IconEditOutlineRegular, IconTrashOutlineRegular, IconSendOutlineRegular, IconCheckOutlineRegular, IconCloseOutlineRegular } from "../../../web/src/ui/shared/primitives/icons/index.tsx";
import { FileTypeIcon } from "../../../web/src/ui/primitives/FileTypeIcon.tsx";
import { Tooltip } from "../../../web/src/ui/shared/primitives/Tooltip.tsx";
import css from "./PiPromptQueue.module.css";

interface Props {
  session: SessionView | null;
  connected: boolean;
  onUpdate(id: string, revision: number, action: QueuedPromptAction): Promise<void>;
}
type Row = { id: string; label: string; text: string; attachments: QueuedPrompt["attachments"]; item?: QueuedPrompt };

/** DSH queue occurrences stay editable until the server hands that exact item to Pi. */
export function PiPromptQueue({ session, connected, onUpdate }: Props) {
  const [collapsed, setCollapsed] = useState(true);
  const [editing, setEditing] = useState<{ id: string; revision: number; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const listId = useId();
  const list = useRef<HTMLOListElement>(null);
  const focusTarget = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (focusTarget.current && editing === null && busy === null) {
      const active = document.activeElement;
      // A late save must not take focus back from a newer composer draft.
      if (!active || active === document.body || list.current?.contains(active)) {
        list.current?.querySelector<HTMLButtonElement>(`[data-prompt-id="${CSS.escape(focusTarget.current)}"] [data-edit-prompt]`)?.focus();
      }
      focusTarget.current = null;
    }
  }, [editing, busy, session?.queuedPrompts]);
  const entries: Row[] = [
    ...(session?.promptQueue?.steering ?? []).map((text, i) => ({ id: `steer-${i}`, label: t("引导", "Steer"), ...displayUserMessage(text) })),
    ...(session?.promptQueue?.followUp ?? []).map((text, i) => ({ id: `native-${i}`, label: t("排队", "Queue"), ...displayUserMessage(text) })),
    ...(session?.queuedPrompts ?? []).map(item => ({ id: item.id, label: t("排队", "Queue"), text: item.text, attachments: item.attachments, item })),
  ];
  useEffect(() => {
    if (entries.length === 0) setCollapsed(true);
    if (editing && !entries.some(row => row.id === editing.id && row.item?.status === "queued")) setEditing(null);
  }, [entries.length, editing, session?.queuedPrompts]);
  if (!entries.length && !session?.hasPendingPrompts) return null;
  const listVisible = entries.length === 1 || !collapsed || editing !== null || busy !== null;
  const count = t(`${entries.length} 条待处理提示词`, `${entries.length} pending prompts`);
  const focusRow = (id: string) => { focusTarget.current = id; };
  const apply = async (item: Pick<QueuedPrompt, "id" | "revision">, action: QueuedPromptAction): Promise<boolean> => {
    if (inFlight.current || !connected) return false;
    inFlight.current = true; setBusy(item.id); setError("");
    try { await onUpdate(item.id, item.revision, action); return true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("队列操作失败", "Queue action failed")); return false; }
    finally { inFlight.current = false; setBusy(null); }
  };
  const save = async () => {
    if (!editing) return;
    const item = editing;
    if (await apply(item, { kind: "edit", text: item.text })) { setEditing(null); focusRow(item.id); }
  };
  const actionButton = (label: string, disabled: boolean, onClick: () => void, icon: ReactNode, edit = false) => <Tooltip portal label={label} side="top" delayMs={500} disabled={disabled}>
    <button className={css.action} type="button" aria-label={label} disabled={disabled} onClick={onClick} data-edit-prompt={edit || undefined}>{icon}</button>
  </Tooltip>;
  return <section className={css.dock} aria-label={t("待处理提示词", "Pending prompts")} data-queue-dock="">
    <div className={css.panel}>
      {entries.length > 1 && <button type="button" className={css.header} aria-label={count} aria-controls={listId} aria-expanded={listVisible} disabled={editing !== null || busy !== null} onClick={() => setCollapsed(value => !value)}>
        <span className={css.lead} aria-hidden><IconQueueOutlineRegular /></span>
        <span className={css.count} role="status">{count}</span>
        {!listVisible && entries.some(row => row.item?.status === "sending") && <span className={css.status}>{t("发送中…", "Sending…")}</span>}
        <span className={css.chevron} aria-hidden>{listVisible ? <IconChevronDownOutlineRegular /> : <IconChevronUpOutlineRegular />}</span>
      </button>}
      {entries.length === 0 && <div className={css.header}><span className={css.lead} aria-hidden><IconQueueOutlineRegular /></span><span className={css.count} role="status">{t("等待 Pi 接收", "Waiting for Pi")}</span></div>}
      <ol ref={list} id={listId} className={css.list} hidden={!listVisible}>{entries.map(row => {
        const item = row.item;
        const locked = !connected || busy !== null || item?.status === "sending";
        return <li key={row.id} className={css.row} data-prompt-id={row.id}>
          {entries.length === 1 && <span className={css.lead} aria-hidden><IconQueueOutlineRegular /></span>}
          <span className={css.kind}>{row.label}</span>
          <div className={css.content}>
            {row.attachments.length > 0 && <span className={css.attachments}>{row.attachments.map((file, ordinal) => <span key={ordinal} className={css.file} title={file.name}><FileTypeIcon path={file.name} /><span>{file.name}</span></span>)}</span>}
            {editing?.id === row.id ? <textarea className={css.editor} autoFocus rows={2} maxLength={32_000} aria-label={t("编辑排队提示词", "Edit queued prompt")} value={editing.text} disabled={busy !== null} onChange={event => setEditing({ ...editing, text: event.target.value })}
              onKeyDown={event => {
                if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                if (event.key === "Escape") { event.preventDefault(); setEditing(null); focusRow(row.id); }
                if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void save(); }
              }} /> : row.text && <span className={css.preview} title={row.text}>{row.text}</span>}
            {item?.error && <span className={css.error} role="alert">{item.error}</span>}
          </div>
          {item?.status === "sending" && <span className={css.status} role="status">{t("发送中…", "Sending…")}</span>}
          {item && <div className={css.actions}>
            {editing?.id === row.id ? <>
              {actionButton(t("保存修改", "Save changes"), locked || !editing.text.trim() && row.attachments.length === 0, () => { void save(); }, <IconCheckOutlineRegular />)}
              {actionButton(t("取消编辑", "Cancel edit"), busy !== null, () => { setEditing(null); focusRow(row.id); }, <IconCloseOutlineRegular />)}
            </> : <>
              {actionButton(t("编辑", "Edit"), locked, () => { setEditing({ id: item.id, revision: item.revision, text: item.text }); setError(""); }, <IconEditOutlineRegular />, true)}
              {actionButton(t("删除", "Delete"), locked, () => { void apply(item, { kind: "remove" }); }, <IconTrashOutlineRegular />)}
              {actionButton(t("发送（引导）", "Send (steer)"), locked || !!session?.idle || !!session?.interactions?.length, () => { void apply(item, { kind: "steer" }); }, <IconSendOutlineRegular />)}
            </>}
          </div>}
        </li>;
      })}</ol>
      {error && <div className={css.error} role="alert">{error}</div>}
      {session?.paused && <div className={css.paused} role="status">{t("已暂停，继续后处理", "Paused; processed on resume")}</div>}
    </div>
  </section>;
}
