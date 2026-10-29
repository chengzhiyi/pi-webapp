import { useEffect, useState } from "react";
import { prior, forgetView } from "./view-journal.ts";
import { hostedApi } from "./api.ts";
import { Modal } from "../../../../web/src/ui/primitives/Modal.tsx";
import { Button } from "../../../../web/src/ui/primitives/Button.tsx";
import css from "./reconciliation.module.css";

/** Reload cannot acknowledge edits from a lost realm. Keep recovery out of the
 * app's layout, and remove records automatically only on a server-confirmed close receipt. */
export function HostedReconciliation({ sessionId, locale }: { sessionId?: string; locale: "zh" | "en" }) {
  const [pending, setPending] = useState(prior);
  const [open, setOpen] = useState(false), [confirm, setConfirm] = useState<(typeof prior)[number] | null>(null);
  const [error, setError] = useState(""), [working, setWorking] = useState(false), [attempt, setAttempt] = useState(0);
  const t = (zh: string, en: string) => locale === "zh" ? zh : en;
  const shown = pending.filter(item => item.sessionId === sessionId);
  const forget = (token: string) => { forgetView(token); setPending(value => value.filter(item => item.viewToken !== token)); };
  useEffect(() => { setOpen(false); setConfirm(null); setError(""); }, [sessionId]);
  useEffect(() => {
    const abort = new AbortController();
    // One request at a time, no polling/automatic discard. Changes to pending
    // only remove entries; session changes and the retry button check again.
    void (async () => {
      for (const item of pending.filter(item => item.sessionId === sessionId)) {
        if (abort.signal.aborted) return;
        try {
          const reply = await hostedApi.view({ ...item, operation: "reconcile" }, abort.signal);
          if (!abort.signal.aborted && reply.recovery === "closed") forget(item.viewToken);
        } catch (cause) {
          // A new frontend can be previewed on an older host. Keep every record
          // when that host lacks proof-based reconciliation; never infer safety.
          if (cause instanceof Error && cause.message === "Unknown view operation") return;
          if (!abort.signal.aborted) setError(String(cause));
        }
      }
    })();
    return () => abort.abort();
  }, [sessionId, attempt]);
  if (!shown.length) return null;
  const kind = (value: string) => ({ controller: t("后台控制器", "Controller"), workspace: t("工作区", "Workspace"), editor: t("编辑器", "Editor"), tool: t("工具预览", "Tool preview") }[value] ?? t("插件视图", "Plugin view"));
  return <>
    <div className={css.entry} data-hosted-recovery><button type="button" className={css.trigger} aria-haspopup="dialog" onClick={() => setOpen(true)}>{t("插件视图恢复", "Plugin view recovery")} · {shown.length}</button></div>
    <Modal open={open} onClose={() => setOpen(false)} title={t("检查刷新前的插件视图", "Review previous plugin views")} closeLabel={t("关闭", "Close")} className={css.dialog} footer={<Button variant="outline" disabled={working} onClick={() => { setError(""); setAttempt(value => value + 1); }}>{t("重新检查", "Check again")}</Button>}>
      <div className={css.content}>
        <p>{t("部分旧视图未完成保存确认。请先检查原标签页、编辑器或本地备份，再处理对应记录。已确认关闭的视图会自动移除。", "Some previous views have no save acknowledgment. Check the original tab, editor or local backup before handling each record. Confirmed closed views are removed automatically.")}</p>
        <p>{t("丢弃未确认的修改不会保存或恢复图稿，无法找回的最新修改可能永久丢失。", "Discarding unconfirmed edits does not save or restore a drawing. Unrecoverable recent edits may be permanently lost.")}</p>
        <div className={css.list}>{shown.map((item, index) => <section className={css.item} key={item.viewToken} data-unconfirmed-view={item.mountId}>
          <h3>{kind(item.kind)} {index + 1}</h3>
          <details><summary>{t("视图信息", "View details")}</summary><dl><dt>{t("插件", "Plugin")}</dt><dd>{item.pluginId}</dd><dt>{t("版本代次", "Generation")}</dt><dd>{item.generation}</dd><dt>{t("视图标识", "View ID")}</dt><dd>{item.mountId}</dd>{item.contentId && <><dt>{t("内容标识", "Content ID")}</dt><dd>{item.contentId}</dd></>}</dl></details>
          <Button variant="outline" disabled={working} onClick={() => setConfirm(item)}>{t("丢弃此视图的未确认修改", "Discard this view's unconfirmed edits")}</Button>
        </section>)}</div>
        {error && <div role="alert" className={css.error}>{t("未能确认部分视图，请保留恢复记录并重试。", "Some views could not be verified. Keep their recovery records and retry.")}<details><summary>{t("诊断信息", "Diagnostics")}</summary>{error}</details></div>}
      </div>
    </Modal>
    <Modal open={!!confirm && open} onClose={() => setConfirm(null)} title={t("丢弃此视图的未确认修改？", "Discard this view's unconfirmed edits?")} closeLabel={t("关闭", "Close")} description={t("请先确认原标签页已关闭，并下载可恢复的草稿。此操作不会保存或恢复内容；无法找回的修改可能永久丢失。", "First confirm the original tab is closed and download any recoverable draft. This does not save or restore content; unrecovered edits may be permanently lost.")} footer={<><Button variant="outline" disabled={working} onClick={() => setConfirm(null)}>{t("取消", "Cancel")}</Button><Button variant="primary" disabled={working} onClick={() => {
      if (!confirm || working) return;
      const item = confirm;
      setWorking(true); setError("");
      void hostedApi.view({ ...item, operation: "discard", confirmation: "discard-unconfirmed-edits" }).then(() => { forget(item.viewToken); setConfirm(null); }).catch(cause => { setError(String(cause)); setConfirm(null); }).finally(() => setWorking(false));
    }}>{t("确认丢弃", "Discard edits")}</Button></>} />
  </>;
}
