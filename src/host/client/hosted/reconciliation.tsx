import { useEffect, useState } from "react";
import { priorViews, forgetView, reconcileView, retainViewForRecovery, discardView, recoveryDrafts, recoveryJournalProblem, type UnconfirmedView } from "./view-journal.ts";
import { downloadDrawing } from "./download.ts";
import { Modal } from "../../../../web/src/ui/primitives/Modal.tsx";
import { Button } from "../../../../web/src/ui/primitives/Button.tsx";
import css from "./reconciliation.module.css";

/** Reconcile in the background even while management is closed. Authoring drafts
 * require explicit retention/discard; controllers contain no local authoring state. */
export function useHostedReconciliation({ sessionId, locale, openRecovered }: { sessionId?: string; locale: "zh" | "en"; openRecovered?(contentId: string): void }) {
  const [pending, setPending] = useState(priorViews);
  const [open, setOpen] = useState(false), [confirm, setConfirm] = useState<{ item: UnconfirmedView; operation: "discard" | "retain" } | null>(null);
  const [error, setError] = useState(""), [working, setWorking] = useState(false), [attempt, setAttempt] = useState(0);
  const t = (zh: string, en: string) => locale === "zh" ? zh : en;
  const shown = pending, journalProblem = recoveryJournalProblem();
  const forget = (token: string) => { forgetView(token); setPending(value => value.filter(item => item.viewToken !== token)); };
  useEffect(() => { setOpen(false); setConfirm(null); setError(""); }, [sessionId]);
  useEffect(() => {
    let alive = true;
    void (async () => {
      for (const item of pending.filter(item => !item.discovered)) {
        if (!alive) return;
        try {
          const state = await reconcileView(item);
          if (!alive) return;
          if (state?.state === "retired" || state?.state === "absent" && item.kind === "controller") forget(item.viewToken);
          else if (state?.state === "retained") setPending(value => value.map(record => record.viewToken === item.viewToken ? { ...record, retained: true } : record));
        } catch (cause) {
          // Older hosts retain every uncertain record, without inferring a save.
          if (cause instanceof Error && cause.message === "Unknown view operation") return;
          if (alive) setError(String(cause));
        }
      }
    })();
    return () => { alive = false; };
  }, [sessionId, attempt]);
  if (!shown.length && !journalProblem) return null;
  const kind = (value: string) => ({ controller: t("后台控制器", "Controller"), workspace: t("工作区", "Workspace"), editor: t("编辑器", "Editor"), tool: t("工具预览", "Tool preview") }[value] ?? t("插件视图", "Plugin view"));
  const retaining = confirm?.operation === "retain";
  return <>
    <div className={css.entry} data-hosted-recovery><p>{t("刷新或关闭窗口后，旧插件视图可能尚未完成保存和关闭确认；部分记录也可能属于仍打开的窗口。请先核对原窗口及备份，再保留失联视图的恢复记录，解除升级等操作的阻塞。", "After reloading or closing a window, previous plugin views may lack save and close confirmations. Some records may belong to windows still open. Check original windows and backups, then retain disconnected views for recovery to unblock updates and other operations.")}</p><button type="button" className={css.trigger} aria-haspopup="dialog" onClick={() => setOpen(true)}>{t("插件视图恢复", "Plugin view recovery")} · {shown.length}</button></div>
    <Modal open={open} onClose={() => setOpen(false)} title={t("检查之前的插件视图", "Review previous plugin views")} closeLabel={t("关闭", "Close")} className={css.dialog} footer={<Button variant="outline" disabled={working} onClick={() => { setError(""); setAttempt(value => value + 1); }}>{t("重新检查", "Check again")}</Button>}>
      <div className={css.content}>
        <p>{t("以下列出所有会话中待确认的旧插件视图。请先检查原窗口、编辑器和本地备份，只处理已失联的视图；仍打开的窗口请先正常保存并关闭。", "These are previous plugin views awaiting confirmation across all sessions. Check original windows, editors and local backups. Only recover disconnected views; save and close windows that remain open first.")}</p>
        <p>{t("保留恢复记录会停止旧视图继续写入，不会覆盖当前图稿。丢弃未确认的记录不会保存或恢复图稿，无法找回的最新修改可能永久丢失。", "Retaining recovery records stops old views writing without overwriting the current drawing. Discarding unconfirmed records does not save or restore a drawing; unrecoverable recent edits may be permanently lost.")}</p>
        <div className={css.list}>{shown.map((item, index) => <section className={css.item} key={item.viewToken} data-unconfirmed-view={item.mountId}>
          <h3>{kind(item.kind)} {index + 1}</h3>
          {item.retained && <p>{t("失联视图的恢复记录已保留。插件可继续操作；旧稿是否完整仍需核对。", "Disconnected view recovery record retained. Plugin operations may continue; the old draft still needs verification.")}</p>}
          <details><summary>{t("视图信息", "View details")}</summary><dl><dt>{t("会话", "Session")}</dt><dd>{item.sessionId}</dd><dt>{t("插件", "Plugin")}</dt><dd>{item.pluginId}</dd><dt>{t("版本代次", "Generation")}</dt><dd>{item.generation}</dd><dt>{t("视图标识", "View ID")}</dt><dd>{item.mountId}</dd>{item.contentId && <><dt>{t("内容标识", "Content ID")}</dt><dd>{item.contentId}</dd></>}</dl></details>
          <div className={css.actions}>
            {recoveryDrafts(item).map(draft => <Button key={draft.name} variant="outline" disabled={working} onClick={() => downloadDrawing({ blob: new Blob([draft.json], { type: "application/json" }), name: draft.name })}>{t("下载本地恢复副本", "Download local recovery copy")} · {draft.name}</Button>)}
            {item.contentId && item.sessionId === sessionId && openRecovered && <Button variant="outline" disabled={working} onClick={() => { setOpen(false); openRecovered(item.contentId!); }}>{t("打开图稿并核对备份", "Open drawing and compare backup")}</Button>}
            {!item.retained && <Button variant="outline" disabled={working} onClick={() => setConfirm({ item, operation: "retain" })}>{t("保留恢复记录并解除阻塞", "Retain recovery record and unblock")}</Button>}
            <Button variant="outline" disabled={working} onClick={() => setConfirm({ item, operation: "discard" })}>{t("丢弃此视图的未确认修改", "Discard this view's unconfirmed edits")}</Button>
          </div>
        </section>)}</div>
        {(error || journalProblem) && <div role="alert" className={css.error}>{t("未能确认部分视图，请保留恢复记录并重试。", "Some views could not be verified. Keep their recovery records and retry.")}<details><summary>{t("诊断信息", "Diagnostics")}</summary>{error || journalProblem}</details></div>}
      </div>
    </Modal>
    <Modal open={!!confirm && open} onClose={() => setConfirm(null)} title={retaining ? t("保留此视图用于恢复？", "Retain this view for recovery?") : t("丢弃此视图的未确认修改？", "Discard this view's unconfirmed edits?")} closeLabel={t("关闭", "Close")} description={retaining ? t("请先确认旧视图已失联并核对备份。此操作保留恢复记录和本地副本，停止旧视图继续写入，不会保存、覆盖或丢弃图稿。", "First confirm the old view is disconnected and review backups. This preserves recovery records and local copies and stops the old view writing, without saving, overwriting or discarding a drawing.") : t("请先确认原标签页已关闭，并下载可恢复的草稿。此操作不会保存或恢复内容；无法找回的修改可能永久丢失。", "First confirm the original tab is closed and download any recoverable draft. This does not save or restore content; unrecovered edits may be permanently lost.")} footer={<><Button variant="outline" disabled={working} onClick={() => setConfirm(null)}>{t("取消", "Cancel")}</Button><Button variant="primary" disabled={working} onClick={() => {
      if (!confirm || working) return;
      const { item, operation } = confirm;
      setWorking(true); setError("");
      void (operation === "retain" ? retainViewForRecovery(item) : discardView(item)).then(() => {
        if (operation === "retain") setPending(priorViews());
        else forget(item.viewToken);
        setConfirm(null);
      }).catch(cause => { setError(String(cause)); setConfirm(null); }).finally(() => setWorking(false));
    }}>{retaining ? t("保留恢复记录", "Retain record") : t("确认丢弃", "Discard edits")}</Button></>} />
  </>;
}
