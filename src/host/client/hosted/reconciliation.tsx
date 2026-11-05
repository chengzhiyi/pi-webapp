import { useEffect, useState } from "react";
import { priorViews, forgetView, settleView, onlyLocalCopy, keepLocalCopyMs, retainViewForRecovery, discardView, recoveryDrafts, recoveryJournalProblem, type UnconfirmedView } from "./view-journal.ts";
import { downloadDrawing } from "./download.ts";
import { hostedApi } from "./api.ts";
import { Modal } from "../../../../web/src/ui/primitives/Modal.tsx";
import { Button } from "../../../../web/src/ui/primitives/Button.tsx";
import css from "./reconciliation.module.css";

/** Reconcile in the background even while management is closed. Records whose window is
 * gone and whose local copy matches the saved drawing clear themselves; authoring drafts
 * that may differ still require explicit retention/discard. */
export function useHostedReconciliation({ sessionId, locale, openRecovered }: { sessionId?: string; locale: "zh" | "en"; openRecovered?(contentId: string): void }) {
  const [pending, setPending] = useState(priorViews);
  const [open, setOpen] = useState(false), [confirm, setConfirm] = useState<{ items: UnconfirmedView[]; operation: "discard" | "retain" } | null>(null);
  const [error, setError] = useState(""), [working, setWorking] = useState(false), [attempt, setAttempt] = useState(0);
  const t = (zh: string, en: string) => locale === "zh" ? zh : en;
  // Views another window is still polling are that window's to save and close.
  const [live, setLive] = useState<ReadonlySet<string>>(new Set());
  // List a record only once checked, so self-clearing records never flash the banner.
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  // Records the host no longer holds block nothing; they only keep a differing local copy.
  const [localOnly, setLocalOnly] = useState<ReadonlySet<string>>(new Set());
  const shown = pending.filter(item => checked.has(item.viewToken) && !live.has(item.viewToken)), journalProblem = recoveryJournalProblem();
  const blocking = shown.filter(item => !localOnly.has(item.viewToken));
  const forget = (token: string) => { forgetView(token); setPending(value => value.filter(item => item.viewToken !== token)); };
  useEffect(() => { setOpen(false); setConfirm(null); setError(""); }, [sessionId]);
  useEffect(() => {
    let alive = true;
    void (async () => {
      let generations = new Map<string, number>();
      try { generations = new Map((await hostedApi.catalog()).plugins.flatMap(card => card.generation === undefined ? [] : [[card.pluginId, card.generation] as const])); }
      catch { /* Without the current generation, drawing copies cannot be compared and stay listed. */ }
      const check = (token: string) => setChecked(value => new Set(value).add(token));
      const standing = (token: string, copyOnly: boolean) => setLocalOnly(value => { const next = new Set(value); if (copyOnly) next.add(token); else next.delete(token); return next; });
      for (const item of pending) {
        if (!alive) return;
        try {
          const state = await settleView(item, generations.get(item.pluginId));
          if (!alive) return;
          if (state?.state === "retired" || state?.state === "absent" && item.kind === "controller") forget(item.viewToken);
          else if (state?.state === "retained") setPending(value => value.map(record => record.viewToken === item.viewToken ? { ...record, retained: true } : record));
          setLive(value => {
            const next = new Set(value);
            if (item.discovered && state?.state === "unconfirmed" && state.stale === false) next.add(item.viewToken); else next.delete(item.viewToken);
            return next;
          });
          standing(item.viewToken, onlyLocalCopy(item, state));
          check(item.viewToken);
        } catch (cause) {
          if (!alive) return;
          // Older hosts retain every uncertain record, without inferring a save.
          if (cause instanceof Error && cause.message === "Unknown view operation") { setChecked(new Set(pending.map(record => record.viewToken))); return; }
          standing(item.viewToken, false); check(item.viewToken); setError(String(cause));
        }
      }
    })();
    return () => { alive = false; };
  }, [sessionId, attempt]);
  if (!shown.length && !journalProblem) return null;
  const kind = (value: string) => ({ controller: t("后台控制器", "Controller"), workspace: t("工作区", "Workspace"), editor: t("编辑器", "Editor"), tool: t("工具预览", "Tool preview") }[value] ?? t("插件视图", "Plugin view"));
  const retaining = confirm?.operation === "retain", bulk = (confirm?.items.length ?? 0) > 1;
  const expires = (item: UnconfirmedView) => Math.max(1, Math.ceil(((item.orphanedAt ?? Date.now()) + keepLocalCopyMs - Date.now()) / 86_400_000));
  const trigger = <button type="button" className={css.trigger} aria-haspopup="dialog" onClick={() => setOpen(true)}>{t("插件视图恢复", "Plugin view recovery")} · {shown.length}</button>;
  return <>
    {blocking.length || journalProblem
      ? <div className={css.entry} data-hosted-recovery><p>{t("刷新或关闭窗口后，部分插件视图尚未确认保存，插件更新、卸载等操作会因此被阻塞。请先核对原窗口及备份，再保留或丢弃这些记录。", "Some plugin views were not confirmed as saved before a window reloaded or closed, which blocks plugin updates, uninstalls and similar operations. Check original windows and backups, then retain or discard these records.")}</p>{trigger}</div>
      : <div className={css.quiet} data-hosted-recovery><span>{t("旧插件视图留有与已保存图稿不同的本地副本，不影响任何操作，到期自动清除。", "Previous plugin views left local copies that differ from saved drawings. They block nothing and clear themselves when they expire.")}</span>{trigger}</div>}
    <Modal open={open} onClose={() => setOpen(false)} title={t("检查之前的插件视图", "Review previous plugin views")} closeLabel={t("关闭", "Close")} className={css.dialog} footer={<>{shown.length > 1 && <Button variant="outline" disabled={working} onClick={() => setConfirm({ items: shown, operation: "discard" })}>{t("全部丢弃", "Discard all")} · {shown.length}</Button>}<Button variant="outline" disabled={working} onClick={() => { setError(""); setAttempt(value => value + 1); }}>{t("重新检查", "Check again")}</Button></>}>
      <div className={css.content}>
        <p>{t("以下列出所有会话中待确认的旧插件视图。请先检查原窗口、编辑器和本地备份，只处理已失联的视图；仍打开的窗口请先正常保存并关闭。", "These are previous plugin views awaiting confirmation across all sessions. Check original windows, editors and local backups. Only recover disconnected views; save and close windows that remain open first.")}</p>
        <p>{t("保留恢复记录会停止旧视图继续写入，不会覆盖当前图稿。丢弃未确认的记录不会保存或恢复图稿，无法找回的最新修改可能永久丢失。", "Retaining recovery records stops old views writing without overwriting the current drawing. Discarding unconfirmed records does not save or restore a drawing; unrecoverable recent edits may be permanently lost.")}</p>
        <div className={css.list}>{shown.map((item, index) => <section className={css.item} key={item.viewToken} data-unconfirmed-view={item.mountId}>
          <h3>{kind(item.kind)} {index + 1}</h3>
          {localOnly.has(item.viewToken)
            ? <p>{t(`此视图已不阻塞任何操作，仅保留与已保存图稿不同的本地副本，约 ${expires(item)} 天后自动清除。`, `This view no longer blocks anything. It only keeps a local copy that differs from the saved drawing, and clears itself in about ${expires(item)} day(s).`)}</p>
            : item.retained && <p>{t("失联视图的恢复记录已保留。插件可继续操作；旧稿是否完整仍需核对。", "Disconnected view recovery record retained. Plugin operations may continue; the old draft still needs verification.")}</p>}
          <details><summary>{t("视图信息", "View details")}</summary><dl><dt>{t("会话", "Session")}</dt><dd>{item.sessionId}</dd><dt>{t("插件", "Plugin")}</dt><dd>{item.pluginId}</dd><dt>{t("版本代次", "Generation")}</dt><dd>{item.generation}</dd><dt>{t("视图标识", "View ID")}</dt><dd>{item.mountId}</dd>{item.contentId && <><dt>{t("内容标识", "Content ID")}</dt><dd>{item.contentId}</dd></>}</dl></details>
          <div className={css.actions}>
            {recoveryDrafts(item).map(draft => <Button key={draft.name} variant="outline" disabled={working} onClick={() => downloadDrawing({ blob: new Blob([draft.json], { type: "application/json" }), name: draft.name })}>{t("下载本地恢复副本", "Download local recovery copy")} · {draft.name}</Button>)}
            {item.contentId && item.sessionId === sessionId && openRecovered && <Button variant="outline" disabled={working} onClick={() => { setOpen(false); openRecovered(item.contentId!); }}>{t("打开图稿并核对备份", "Open drawing and compare backup")}</Button>}
            {!item.retained && !localOnly.has(item.viewToken) && <Button variant="outline" disabled={working} onClick={() => setConfirm({ items: [item], operation: "retain" })}>{t("保留恢复记录并解除阻塞", "Retain recovery record and unblock")}</Button>}
            <Button variant="outline" disabled={working} onClick={() => setConfirm({ items: [item], operation: "discard" })}>{t("丢弃此视图的未确认修改", "Discard this view's unconfirmed edits")}</Button>
          </div>
        </section>)}</div>
        {(error || journalProblem) && <div role="alert" className={css.error}>{t("未能确认部分视图，请保留恢复记录并重试。", "Some views could not be verified. Keep their recovery records and retry.")}<details><summary>{t("诊断信息", "Diagnostics")}</summary>{error || journalProblem}</details></div>}
      </div>
    </Modal>
    <Modal open={!!confirm && open} onClose={() => setConfirm(null)} title={retaining ? t("保留此视图用于恢复？", "Retain this view for recovery?") : bulk ? t(`丢弃全部 ${confirm!.items.length} 个视图的未确认修改？`, `Discard unconfirmed edits from all ${confirm!.items.length} views?`) : t("丢弃此视图的未确认修改？", "Discard this view's unconfirmed edits?")} closeLabel={t("关闭", "Close")} description={retaining ? t("请先确认旧视图已失联并核对备份。此操作保留恢复记录和本地副本，停止旧视图继续写入，不会保存、覆盖或丢弃图稿。", "First confirm the old view is disconnected and review backups. This preserves recovery records and local copies and stops the old view writing, without saving, overwriting or discarding a drawing.") : bulk ? t("请先确认原标签页都已关闭，并下载需要保留的草稿。此操作会清除全部记录及其本地副本，不会保存或恢复内容；无法找回的修改可能永久丢失。", "First confirm the original tabs are closed and download any drafts you want to keep. This clears every record and its local copies without saving or restoring content; unrecovered edits may be permanently lost.") : t("请先确认原标签页已关闭，并下载可恢复的草稿。此操作不会保存或恢复内容；无法找回的修改可能永久丢失。", "First confirm the original tab is closed and download any recoverable draft. This does not save or restore content; unrecovered edits may be permanently lost.")} footer={<><Button variant="outline" disabled={working} onClick={() => setConfirm(null)}>{t("取消", "Cancel")}</Button><Button variant="primary" disabled={working} onClick={() => {
      if (!confirm || working) return;
      const { items, operation } = confirm;
      setWorking(true); setError("");
      void (async () => {
        // One at a time, so a refusal leaves every record not yet discarded intact.
        for (const item of items) {
          if (operation === "retain") {
            await retainViewForRecovery(item);
            setPending(priorViews()); setLocalOnly(value => new Set(value).add(item.viewToken));
          } else { await discardView(item); forget(item.viewToken); }
        }
      })().then(() => setConfirm(null)).catch(cause => { setError(String(cause)); setConfirm(null); }).finally(() => setWorking(false));
    }}>{retaining ? t("保留恢复记录", "Retain record") : bulk ? t("全部丢弃", "Discard all") : t("确认丢弃", "Discard edits")}</Button></>} />
  </>;
}
