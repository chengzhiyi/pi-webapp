import { useEffect, useRef, useState } from "react";
import { OFFICIAL_HOSTED_PLUGIN, type HostedPluginCard, type HostedPluginCatalog, type HostedManageOperation } from "../../../contracts/hosted-plugins.ts";
import { hostedApi } from "./api.ts";
import { ExcalidrawIcon } from "../../../../web/src/ui/primitives/ExcalidrawIcon.tsx";
import { Button } from "../../../../web/src/ui/primitives/Button.tsx";
import { Modal } from "../../../../web/src/ui/primitives/Modal.tsx";
import css from "./management.module.css";

type Problem = { code?: string; message: string };
/** One actionable message per failure; raw diagnostics remain inspectable, not repeated. */
function problemText(problem: Problem, installed: boolean, t: (zh: string, en: string) => string) {
  const messages: Record<string, string> = {
    metadata_not_found: t("官方插件暂未发布，暂不可安装。稍后可重新检查。", "The official package is not currently published. Check again later."),
    tarball_not_found: t("发行文件暂不可用。请重新检查或稍后重试。", "The release file is unavailable. Check again or retry later."),
    no_compatible_version: t("暂无适用于此软件版本的插件。稍后可重新检查。", "No compatible release for this app version. Check again later."),
    registry_unreachable: t("暂时无法访问下载服务。请检查网络后重试。", "Cannot reach the download service. Check your network and retry."),
    download_cancelled: t("下载已取消。", "Download cancelled."),
  };
  const text = messages[problem.code ?? ""] ?? t("操作未完成。请查看诊断信息后重试。", "Operation did not finish. Review diagnostics and retry.");
  return (installed && ["metadata_not_found", "tarball_not_found", "no_compatible_version", "registry_unreachable", "download_cancelled"].includes(problem.code ?? "") ? t("更新未完成，当前插件及数据已保留。", "Update did not finish; current plugin and data retained. ") : "") + text;
}

/** Static official catalog survives offline/404; installed and enabled require server confirmation. */
export function HostedPluginManagement({ locale, generation = 0 }: { locale: "zh" | "en"; generation?: number }) {
  const t = (zh: string, en: string) => locale === "zh" ? zh : en;
  const [catalog, setCatalog] = useState<HostedPluginCatalog>({ plugins: [OFFICIAL_HOSTED_PLUGIN], offline: true });
  const [known, setKnown] = useState(false);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const [download, setDownload] = useState<{ pluginId: string; id: string } | null>(null);
  const [error, setError] = useState<Problem | null>(null);
  const [operationError, setOperationError] = useState<{ id: string; problem: Problem } | null>(null);
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);
  const [confirm, setConfirm] = useState<{ card: HostedPluginCard; operation: HostedManageOperation; reopen?: boolean } | null>(null);
  const problem = (cause: unknown): Problem => ({ message: cause instanceof Error ? cause.message : String(cause), code: (cause as Problem)?.code });
  useEffect(() => {
    let alive = true; const abort = new AbortController();
    void hostedApi.catalog(abort.signal).then(value => { if (alive) { setCatalog(value); setKnown(true); setError(null); } }).catch(cause => { if (alive) { setError(problem(cause)); setCatalog(previous => ({ ...previous, offline: true })); } });
    return () => { alive = false; abort.abort(); };
  }, [generation, reload]);
  const operate = async (card: HostedPluginCard, operation: HostedManageOperation, reopenEditors = false) => {
    if (locked.current) return;
    locked.current = true; setConfirm(null);
    const downloadId = ["install", "update", "check"].includes(operation) ? crypto.randomUUID() : undefined;
    setDownload(downloadId ? { pluginId: card.pluginId, id: downloadId } : null);
    setBusy(true); setOperationError(null); setNotice("");
    try {
      const next = await hostedApi.manage({ pluginId: card.pluginId, operation, ...(downloadId ? { downloadId } : {}), ...(reopenEditors ? { reopenEditors: true } : {}) });
      setCatalog(next); setKnown(true);
      setNotice(next.plugins.some(p => p.pendingVersion) ? t("更新已准备好，关闭编辑器后生效。", "Update ready. Close editors to apply.") : t("操作完成。", "Done."));
      window.dispatchEvent(new Event("pi:hosted-catalog-changed"));
    } catch (cause) {
      setOperationError({ id: card.pluginId, problem: problem(cause) });
      // Read authoritative state after failure, including post-commit failures. Never retry mutations.
      try { setCatalog(await hostedApi.catalog()); setKnown(true); } catch { /* keep the operation failure visible */ }
    } finally { locked.current = false; setBusy(false); setDownload(null); }
  };
  const request = (card: HostedPluginCard, operation: HostedManageOperation) => {
    if (operation === "disable" || operation === "uninstall") setConfirm({ card, operation });
    else void operate(card, operation);
  };
  const cards = catalog.plugins.some(card => card.pluginId === OFFICIAL_HOSTED_PLUGIN.pluginId) ? catalog.plugins : [...catalog.plugins, OFFICIAL_HOSTED_PLUGIN];
  return <section className={css.section} data-hosted-management aria-busy={busy}>
    <h2>{t("官方插件", "Official plugins")}</h2>
    <p className={css.status}>{t("软件更新时，已安装的插件会一起更新；打开的编辑器关闭后生效。", "Installed plugins update with the app, after open editors close.")}</p>
    {error && <div role="alert" className={css.error}>{t("无法读取插件状态，请重试。", "Cannot read plugin status. Please retry.")}<details><summary>{t("诊断信息", "Diagnostics")}</summary>{error.message}</details></div>}
    {notice && <p className={css.notice} role="status">{notice}</p>}
    <Button variant="outline" disabled={busy} onClick={() => { setOperationError(null); setReload(value => value + 1); }}>{t("重新读取状态", "Reload status")}</Button>
    {download && <Button variant="outline" onClick={() => {
      void hostedApi.manage({ pluginId: download.pluginId, operation: "cancel-download", downloadId: download.id }).then(() => setNotice(t("已请求取消，已完成的安装不会回滚。", "Cancellation requested; committed installations are not rolled back."))).catch(cause => setOperationError({ id: download.pluginId, problem: problem(cause) }));
    }}>{t("取消下载（不回滚已提交安装）", "Cancel download (no rollback after commit)")}</Button>}
    <ul className={css.cards}>{cards.map(card => {
      const diagnostic = card.updateDiagnostic;
      const failure = operationError?.id === card.pluginId ? operationError.problem : card.error ? { code: card.errorCode, message: card.error } : diagnostic?.status === "failed" ? diagnostic : null;
      const unavailable = !!failure && ["metadata_not_found", "tarball_not_found", "no_compatible_version"].includes(failure.code ?? "");
      const actions: HostedManageOperation[] = !card.installed ? ["install", "check"] : [card.enabled ? "disable" : "enable", "check", "update", "uninstall", ...(card.pendingVersion ? ["retry" as const] : [])];
      return <li className={css.card} key={card.pluginId} data-hosted-card={card.pluginId}>
        <div className={css.heading}><span className={css.artwork} aria-hidden="true"><ExcalidrawIcon size={26} /></span><div><h3>{card.name} {card.official && t("（官方）", "(Official)")}</h3><code>{card.pluginId}</code></div></div>
        <p className={css.status}>{!known ? t("安装状态未知 · 启用状态未知", "Installation unknown · Enablement unknown") : `${card.installed ? t("已安装", "Installed") : t("未安装", "Not installed")} · ${card.enabled ? t("已启用", "Enabled") : t("未启用", "Disabled")}`} {card.version}</p>
        {card.availableVersion && <p role="status">{t("可用版本：", "Available release: ")}{card.availableVersion}</p>}
        {card.pendingVersion && <p role="status">{t("关闭编辑器后更新至：", "Close editors to update to: ")}{card.pendingVersion}</p>}
        {failure && <div className={css.error} role="alert">{problemText(failure, card.installed, t)}<details><summary>{t("诊断信息", "Diagnostics")}</summary><code>{failure.code}</code><p>{failure.message}</p>{diagnostic && <p>{diagnostic.checkedAt} · {diagnostic.hostVersion}</p>}{/lock|owned/i.test(failure.message) && <p>{t("停止所有程序并备份后，按 docs/hosted-update-recovery.md 恢复。此页面不会清锁。", "Stop all hosts and back up data before following docs/hosted-update-recovery.md. This page never clears locks.")}</p>}</details></div>}
        {!failure && diagnostic?.status === "up-to-date" && !card.pendingVersion && <p className={css.status}>{t("兼容版本检查已完成。", "Compatible release check complete.")}</p>}
        <div className={css.actions}>{actions.map(operation => <Button variant={operation === "install" ? "primary" : "outline"} size="sm" key={operation} disabled={busy || !known || !!catalog.offline || operation === "install" && unavailable} onClick={() => request(card, operation)}>{({ install: unavailable ? t("暂不可安装", "Unavailable") : t("安装", "Install"), enable: t("启用", "Enable"), disable: t("停用", "Disable"), check: t("检查更新", "Check updates"), update: t("更新（等待编辑器关闭）", "Update (wait for editors)"), uninstall: t("卸载", "Uninstall"), retry: t("应用待更新版本", "Apply pending update") } as Record<string, string>)[operation]}</Button>)}
        {card.pendingVersion && <Button variant="outline" size="sm" disabled={busy || !!catalog.offline} onClick={() => setConfirm({ card, operation: "update", reopen: true })}>{t("立即更新并重新打开", "Update and reopen now")}</Button>}</div>
      </li>;
    })}</ul>
    <Modal open={confirm !== null} onClose={() => setConfirm(null)} title={confirm?.reopen ? t("立即更新？", "Update now?") : t("关闭插件视图？", "Close plugin views?")} closeLabel={t("关闭", "Close")} description={confirm?.reopen ? t("重新打开会清空撤销/重做历史。只有全部视图保存成功才会继续。", "Reopening clears undo/redo history. All views must save successfully before continuing.") : t("相关视图将在保存成功后关闭。工作区文件和插件数据不会删除。", "Related views close only after saving successfully. Workspace files and plugin data are retained.")} footer={<><Button variant="outline" onClick={() => setConfirm(null)}>{t("取消", "Cancel")}</Button><Button variant="primary" onClick={() => { if (confirm) void operate(confirm.card, confirm.operation, confirm.reopen); }}>{t("继续", "Continue")}</Button></>} />
  </section>;
}
