import { useState } from "react";
import { prior, forgetView } from "./view-journal.ts";
import { hostedApi } from "./api.ts";
import styles from "./reconciliation.module.css";

/** A reload is NOT a handoff. Only an explicit decision for EACH lost capability retires it.
 * This journal identifies capabilities, never purports to contain the latest local draft.
 */
export function HostedReconciliation({ sessionId, locale = "en" }: { sessionId?: string; locale?: "zh" | "en" }) {
  const [pending, setPending] = useState(prior);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const views = pending.filter(item => item.sessionId === sessionId);
  if (!views.length) return null;
  const zh = locale === "zh";
  return <details className={styles.notice} data-hosted-recovery="">
    <summary className={styles.summary}>{zh ? `插件草稿待确认（${views.length}）· 查看详情` : `Plugin drafts need review (${views.length}) · View details`}</summary>
    <div className={styles.content}>
    <p>{zh ? "刷新前的插件视图未能确认保存状态，不一定表示内容丢失。请先在插件中检查本地备份或下载草稿；恢复备份可能覆盖当前绘图。" : "Plugin views from before the reload could not confirm their saved state. This does not necessarily mean edits were lost. Check local backups or download drafts in the plugin first; restoring may replace the current drawing."}</p>
    {views.map(item => <section key={item.viewToken} className={styles.view} data-unconfirmed-view={item.mountId}>
    <p className={styles.identity}>{zh ? "待确认视图" : "Unconfirmed view"}: {item.kind} · {item.contentId ?? item.mountId} · {zh ? "版本" : "generation"} {item.generation}</p>
    <p>{zh ? "此视图的最新编辑尚未确认保存。请确认它未在其他标签页中打开，并先找回草稿。仅在确认不再需要这些编辑后丢弃；此操作可能永久丢失未保存内容。" : "This view's latest edits have NOT been acknowledged. Check it is no longer open in another tab and recover drafts first. Only discard edits you no longer need; unsaved content may be permanently lost."}</p>
    <button className={styles.button} disabled={working} onClick={() => {
      if (!window.confirm(zh ? `丢弃 ${item.kind} 视图 ${item.mountId} 的全部未确认编辑？这不会保存或恢复内容。请先下载可找回的草稿。` : `Discard ALL unconfirmed edits for ${item.kind} view ${item.mountId}? This does not save or restore them. Download any recoverable draft first.`)) return;
      setWorking(true); setError("");
      void hostedApi.view({ ...item, operation: "discard", confirmation: "discard-unconfirmed-edits" }).then(() => {
        forgetView(item.viewToken); setPending(value => value.filter(record => record.viewToken !== item.viewToken));
      }).catch(cause => setError(String(cause))).finally(() => setWorking(false));
    }}>{zh ? "丢弃此视图的未确认编辑" : "Discard unconfirmed edits for this view"}</button>
  </section>)}{error && <p className={styles.error} role="alert">{error}</p>}
    </div>
  </details>;
}
