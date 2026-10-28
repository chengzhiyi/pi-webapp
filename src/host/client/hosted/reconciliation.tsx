import { useEffect, useState } from "react";
import { prior, forgetView, reconcileView, retainViewForRecovery, discardView, recoveryDrafts, recoveryJournalProblem, type UnconfirmedView } from "./view-journal.ts";
import { downloadDrawing } from "./download.ts";
import styles from "./reconciliation.module.css";

/** Reconcile only exact old capabilities. Retention revokes stale admission but never
 * claims the old document was saved, and never applies a backup over current data.
 */
export function HostedReconciliation({ sessionId, locale = "en", openRecovered }: { sessionId?: string; locale?: "zh" | "en"; openRecovered?(contentId: string): void }) {
  const [pending, setPending] = useState(prior);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const t = (zh: string, en: string) => locale === "zh" ? zh : en;
  const refresh = async (item: UnconfirmedView) => {
    const result = await reconcileView(item);
    if (result?.state === "retired" || result?.state === "absent" && item.kind === "controller") {
      setPending(value => value.filter(record => record.viewToken !== item.viewToken));
    } else if (result?.state === "retained") {
      setPending(value => value.map(record => record.viewToken === item.viewToken ? { ...record, retained: true } : record));
    }
  };
  useEffect(() => {
    let alive = true;
    void Promise.all(pending.filter(item => item.sessionId === sessionId).map(refresh)).catch(cause => { if (alive) setError(String(cause)); });
    return () => { alive = false; };
  }, [sessionId]);
  const perform = async (operation: () => Promise<void>) => {
    if (working) return;
    setWorking(true); setError("");
    try { await operation(); } catch (cause) { setError(String(cause)); } finally { setWorking(false); }
  };
  const views = pending.filter(item => item.sessionId === sessionId);
  const journalProblem = recoveryJournalProblem();
  if (!views.length && !journalProblem) return null;
  return <details className={styles.notice} data-hosted-recovery="">
    <summary className={styles.summary}>{t(`插件草稿待确认（${views.length}）· 查看详情`, `Plugin drafts need review (${views.length}) · View details`)}</summary>
    <div className={styles.content}>
    {views.map(item => {
    const drafts = recoveryDrafts(item);
    return <section key={item.viewToken} className={styles.view} data-unconfirmed-view={item.mountId}>
      <p className={styles.identity}>{t("待确认视图", "Unconfirmed view")}: {item.kind} · {item.contentId ?? item.mountId} · {t("版本", "generation")} {item.generation}</p>
      <p>{item.retained
        ? t("失联视图的恢复记录已保留。插件可继续操作；旧稿是否完整仍需核对。", "Disconnected view recovery record retained. Plugin operations may continue; the old draft still needs verification.")
        : t(`上一页面的 ${item.kind} 视图尚未完成关闭确认。请核对本地草稿后，将失联视图保留用于恢复。`, `Previous-document ${item.kind} view has not acknowledged closure. Check local drafts, then retain the disconnected view for recovery.`)}</p>
      <p>{t("恢复副本不会覆盖当前图稿。若旧视图仍在其他标签页打开，请先在那里保存或下载。", "Recovery copies do not overwrite the current drawing. If the old view is still open in another tab, save or download there first.")}</p>
      {drafts.map(draft => <button className={styles.button} key={draft.name} disabled={working} onClick={() => downloadDrawing({ blob: new Blob([draft.json], { type: "application/json" }), name: draft.name })}>{t("下载本地恢复副本", "Download local recovery copy")} · {draft.name}</button>)}
      {item.contentId && openRecovered && <button className={styles.button} disabled={working} onClick={() => openRecovered(item.contentId!)}>{t("打开图稿并核对备份", "Open drawing and compare backup")}</button>}
      {!item.retained && <button className={styles.button} disabled={working} onClick={() => { void perform(async () => {
        if (!window.confirm(t("确认旧视图已失联，并保留其恢复记录及现有本地备份？这会停止旧视图继续写入，不会保存、覆盖或丢弃图稿。", "Retain this disconnected view for recovery? This revokes its old write capability without saving, replacing or discarding its drawing."))) return;
        await retainViewForRecovery(item);
        setPending(value => value.map(record => record.viewToken === item.viewToken ? { ...record, retained: true } : record));
      }); }}>{t("保留恢复记录并解除阻塞", "Retain recovery record and unblock")}</button>}
      <button className={styles.button} disabled={working} onClick={() => { void perform(() => refresh(item)); }}>{t("核对视图状态", "Check view state")}</button>
      <button className={styles.button} disabled={working} onClick={() => { void perform(async () => {
        if (!window.confirm(t("永久丢弃此视图的未确认编辑记录？请先下载可恢复的草稿；这不会保存或恢复图稿。", "Discard unconfirmed edits for this view? Download any recoverable draft first. This does not save or restore the drawing."))) return;
        await discardView(item); forgetView(item.viewToken);
        setPending(value => value.filter(record => record.viewToken !== item.viewToken));
      }); }}>{t("丢弃此视图的未确认记录", "Discard unconfirmed edits for this view")}</button>
    </section>;
  })}{(error || journalProblem) && <p className={styles.error} role="alert">{error || journalProblem}</p>}
    </div>
  </details>;
}
