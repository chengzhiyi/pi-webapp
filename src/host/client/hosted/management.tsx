import { useEffect, useRef, useState } from "react";
import { OFFICIAL_HOSTED_PLUGIN, type HostedPluginCard, type HostedPluginCatalog, type HostedManageOperation } from "../../../contracts/hosted-plugins.ts";
import { hostedApi } from "./api.ts";
import { ExcalidrawIcon } from "../../../../web/src/ui/primitives/ExcalidrawIcon.tsx";
import { Button } from "../../../../web/src/ui/primitives/Button.tsx";
import { Modal } from "../../../../web/src/ui/primitives/Modal.tsx";
import rows from "../PluginManagementPage.module.css";
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
    runtime_owned: t("插件运行时被其他宿主或遗留锁占用，当前无法打开或卸载。请停止所有宿主并校验备份后，按恢复说明处理；重新安装不会清除此锁。", "Another host or a retained ownership lock blocks this runtime, including opening and uninstalling. Stop all hosts, verify a backup and follow recovery instructions; reinstalling does not clear the lock."),
  };
  const text = messages[problem.code ?? ""] ?? t("操作未完成。请查看诊断信息后重试。", "Operation did not finish. Review diagnostics and retry.");
  return (installed && ["metadata_not_found", "tarball_not_found", "no_compatible_version", "registry_unreachable", "download_cancelled"].includes(problem.code ?? "") ? t("更新未完成，当前插件及数据已保留。", "Update did not finish; current plugin and data retained. ") : "") + text;
}

interface Props {
  locale: "zh" | "en";
  generation?: number;
  reload?: number;
  query?: string;
  selectedId: string | null;
  visible?: boolean;
  disabled?: boolean;
  onSelect(card: { id: string; name: string }): void;
  onBusyChange(busy: boolean): void;
  onMatchCountChange(count: number): void;
}

/** Official packages share built-in rows and switches; lifecycle/configuration lives in details. */
export function HostedPluginManagement({ locale, generation = 0, reload = 0, query = "", selectedId, visible = true, disabled = false, onSelect, onBusyChange, onMatchCountChange }: Props) {
  const t = (zh: string, en: string) => locale === "zh" ? zh : en;
  const [catalog, setCatalog] = useState<HostedPluginCatalog>({ plugins: [OFFICIAL_HOSTED_PLUGIN], offline: true });
  const [known, setKnown] = useState(false);
  const [reading, setReading] = useState(true);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const readEpoch = useRef(0);
  const [download, setDownload] = useState<{ pluginId: string; id: string } | null>(null);
  const [error, setError] = useState<Problem | null>(null);
  const [operationError, setOperationError] = useState<{ id: string; problem: Problem } | null>(null);
  const [notice, setNotice] = useState("");
  const [retryRead, setRetryRead] = useState(0);
  const [confirm, setConfirm] = useState<{ card: HostedPluginCard; operation: HostedManageOperation; reopen?: boolean } | null>(null);
  const problem = (cause: unknown): Problem => ({ message: cause instanceof Error ? cause.message : String(cause), code: (cause as Problem)?.code });
  useEffect(() => {
    if (locked.current) return;
    const epoch = ++readEpoch.current;
    const abort = new AbortController();
    setReading(true); setOperationError(null);
    void hostedApi.catalog(abort.signal).then(value => {
      if (epoch === readEpoch.current) { setCatalog(value); setKnown(true); setError(null); }
    }).catch(cause => {
      if (!abort.signal.aborted && epoch === readEpoch.current) { setError(problem(cause)); setCatalog(previous => ({ ...previous, offline: true })); }
    }).finally(() => { if (epoch === readEpoch.current) setReading(false); });
    return () => { abort.abort(); };
  }, [generation, reload, retryRead]);
  const operate = async (card: HostedPluginCard, operation: HostedManageOperation, reopenEditors = false) => {
    if (locked.current || disabled || reading) return;
    locked.current = true; ++readEpoch.current; setConfirm(null);
    const downloadId = ["install", "update", "check"].includes(operation) ? crypto.randomUUID() : undefined;
    setDownload(downloadId ? { pluginId: card.pluginId, id: downloadId } : null);
    setBusy(true); onBusyChange(true); setOperationError(null); setNotice("");
    try {
      const next = await hostedApi.manage({ pluginId: card.pluginId, operation, ...(downloadId ? { downloadId } : {}), ...(reopenEditors ? { reopenEditors: true } : {}) });
      setCatalog(next); setKnown(true); setError(null);
      setNotice(next.plugins.some(p => p.pendingVersion) ? t("更新已准备好，关闭编辑器后生效。", "Update ready. Close editors to apply.") : t("操作完成。", "Done."));
      window.dispatchEvent(new Event("pi:hosted-catalog-changed"));
    } catch (cause) {
      setOperationError({ id: card.pluginId, problem: problem(cause) });
      // Read authoritative state after failure, including post-commit failures. Never retry mutations.
      try { setCatalog(await hostedApi.catalog()); setKnown(true); } catch { /* keep the operation failure visible */ }
    } finally { locked.current = false; setBusy(false); onBusyChange(false); setDownload(null); }
  };
  const request = (card: HostedPluginCard, operation: HostedManageOperation) => {
    if (operation === "disable" || operation === "uninstall") setConfirm({ card, operation });
    else void operate(card, operation);
  };
  const cards = catalog.plugins.some(card => card.pluginId === OFFICIAL_HOSTED_PLUGIN.pluginId) ? catalog.plugins : [...catalog.plugins, OFFICIAL_HOSTED_PLUGIN];
  const selected = cards.find(card => card.pluginId === selectedId);
  const shown = cards.filter(card => `${card.name} ${card.pluginId} ${description(card)}`.toLowerCase().includes(query.trim().toLowerCase()));
  useEffect(() => { onMatchCountChange(shown.length); }, [shown.length, onMatchCountChange]);
  const unavailableControls = busy || reading || disabled || !known || !!catalog.offline;
  function description(card: HostedPluginCard) {
    return card.contribution?.entry.description[locale] ?? (card.pluginId === OFFICIAL_HOSTED_PLUGIN.pluginId
      ? t("绘制、编辑手绘图表，并将图稿保存到工作区。", "Draw and edit hand-drawn diagrams, and save them to your workspace.")
      : t("按需下载安装的官方插件。", "An official plugin available on demand."));
  }
  const name = (card: HostedPluginCard) => `${card.name}${card.official ? t("（官方）", " (Official)") : ""}`;
  const failureFor = (card: HostedPluginCard): Problem | null => operationError?.id === card.pluginId ? operationError.problem : card.error ? { code: card.errorCode, message: card.error } : card.updateDiagnostic?.status === "failed" ? card.updateDiagnostic : null;
  const status = (card: HostedPluginCard) => !known ? t("安装状态未知 · 启用状态未知", "Installation unknown · Enablement unknown") : `${card.installed ? t("已安装", "Installed") : t("未安装", "Not installed")} · ${card.enabled ? t("已启用", "Enabled") : t("未启用", "Disabled")}${card.version ? ` ${card.version}` : ""}${card.enabled && card.phase !== "active" ? t(" · 运行时不可用", " · Runtime unavailable") : ""}`;
  const switchFor = (card: HostedPluginCard) => <button type="button" role="switch" className={rows.switch} aria-label={t(`启用 ${card.name}`, `Enable ${card.name}`)} aria-checked={known && card.enabled} disabled={unavailableControls || !card.installed} title={!known ? t("请先读取插件状态", "Read plugin status first") : !card.installed ? t("请先下载插件", "Download the plugin first") : undefined} onClick={() => request(card, card.enabled ? "disable" : "enable")}><span className={rows.thumb} /></button>;
  const downloadFor = (card: HostedPluginCard) => {
    const failure = failureFor(card);
    const unavailable = !card.installed && !!failure && ["metadata_not_found", "tarball_not_found", "no_compatible_version"].includes(failure.code ?? "");
    return <Button variant="outline" size="sm" disabled={unavailableControls || unavailable} onClick={() => request(card, card.pendingVersion ? "retry" : card.installed ? "update" : "install")}>{card.pendingVersion ? t("应用待更新版本", "Apply pending update") : card.installed ? t("更新", "Update") : unavailable ? t("暂不可下载", "Unavailable") : t("下载", "Download")}</Button>;
  };
  const failureView = (card: HostedPluginCard, detail: boolean) => {
    const failure = failureFor(card), diagnostic = card.updateDiagnostic;
    if (!failure) return null;
    return <div className={css.error} role="alert">{problemText(failure, card.installed, t)}{detail && <details><summary>{t("诊断信息", "Diagnostics")}</summary><code>{failure.code}</code><p>{failure.message}</p>{diagnostic && <p>{diagnostic.checkedAt} · {diagnostic.hostVersion}</p>}{/lock|owned/i.test(failure.message) && <p>{t("停止所有程序并备份后，按 docs/hosted-update-recovery.md 恢复。此页面不会清锁。", "Stop all hosts and back up data before following docs/hosted-update-recovery.md. This page never clears locks.")}</p>}</details>}</div>;
  };
  return <section className={css.section} data-hosted-management aria-busy={busy || reading} style={!visible ? { display: "none" } : undefined}>
    {!selected && <h2>{t("官方插件", "Official plugins")} <span>{shown.length}</span></h2>}
    {error && <div role="alert" className={css.error}>{t("无法读取插件状态，请重试。", "Cannot read plugin status. Please retry.")}<details><summary>{t("诊断信息", "Diagnostics")}</summary>{error.message}</details><Button variant="outline" size="sm" disabled={busy || reading || disabled} onClick={() => setRetryRead(value => value + 1)}>{t("重试", "Retry")}</Button></div>}
    {notice && <p className={css.notice} role="status">{notice}</p>}
    {download && <Button variant="outline" onClick={() => {
      void hostedApi.manage({ pluginId: download.pluginId, operation: "cancel-download", downloadId: download.id }).then(() => setNotice(t("已请求取消，已完成的安装不会回滚。", "Cancellation requested; committed installations are not rolled back."))).catch(cause => setOperationError({ id: download.pluginId, problem: problem(cause) }));
    }}>{t("取消下载（不回滚已提交安装）", "Cancel download (no rollback after commit)")}</Button>}
    {selected ? <div className={rows.detail} data-hosted-detail={selected.pluginId}>
      <div className={rows.detailHead}><span className={rows.artwork} aria-hidden="true"><ExcalidrawIcon size={30} /></span><div><strong>{name(selected)}</strong><p>{description(selected)}</p></div>{switchFor(selected)}</div>
      <dl><dt>{t("插件标识", "Plugin ID")}</dt><dd><code>{selected.pluginId}</code></dd><dt>{t("来源", "Source")}</dt><dd>{t("按需下载的官方插件", "Official on-demand package")}</dd><dt>{t("状态", "Status")}</dt><dd>{status(selected)}</dd>{selected.availableVersion && <><dt>{t("可用版本", "Available release")}</dt><dd>{selected.availableVersion}</dd></>}{selected.pendingVersion && <><dt>{t("待更新版本", "Pending release")}</dt><dd>{selected.pendingVersion}</dd></>}</dl>
      {failureView(selected, true)}
      <section className={css.configuration}><h2>{t("配置与更新", "Configuration & updates")}</h2>
        <p className={rows.scope}>{t("无需额外配置。启用后，可从工作区侧栏打开，也可查看对话中的图稿。图稿保存在工作区，停用或卸载不会删除文件和插件数据。", "No additional configuration is required. Once enabled, open it from the workspace sidebar or view diagrams in conversations. Disabling or uninstalling retains workspace files and plugin data.")}</p>
        <p className={rows.scope}>{t("软件更新时，已安装的插件会一起更新；打开的编辑器关闭后生效。", "Installed plugins update with the app, after open editors close.")}</p>
        <p className={rows.scope}>{t("停用或卸载前会先保存并关闭相关视图；保存失败时不会继续。", "Disabling or uninstalling first saves and closes related views; a failed save stops the operation.")}</p>
        {selected.pendingVersion && <p className={rows.scope} role="status">{t("关闭编辑器后更新至：", "Close editors to update to: ")}{selected.pendingVersion}</p>}
        {!failureFor(selected) && selected.updateDiagnostic?.status === "up-to-date" && !selected.pendingVersion && <p className={rows.scope}>{t("兼容版本检查已完成。", "Compatible release check complete.")}</p>}
        <div className={css.actions}>{downloadFor(selected)}<Button variant="outline" size="sm" disabled={unavailableControls} onClick={() => request(selected, "check")}>{t("检查更新", "Check updates")}</Button>
          {selected.installed && <Button variant="outline" size="sm" disabled={unavailableControls} onClick={() => request(selected, "uninstall")}>{t("卸载", "Uninstall")}</Button>}
          {selected.pendingVersion && <Button variant="outline" size="sm" disabled={unavailableControls} onClick={() => setConfirm({ card: selected, operation: "update", reopen: true })}>{t("立即更新并重新打开", "Update and reopen now")}</Button>}
        </div>
      </section>
    </div> : <ul className={rows.cards}>{shown.map(card => <li className={rows.card} key={card.pluginId} data-hosted-card={card.pluginId}>
      <span className={rows.artwork} aria-hidden="true"><ExcalidrawIcon size={30} /></span>
      <div className={rows.cardMain}><button className={rows.cardOpen} type="button" onClick={() => onSelect({ id: card.pluginId, name: card.name })}>{name(card)}</button><p>{description(card)}</p><small><span className={rows.dot} data-enabled={known && card.enabled} />{busy ? t("正在应用…", "Applying…") : status(card)}</small>
        {card.pendingVersion ? <small>{t("关闭编辑器后更新至：", "Close editors to update to: ")}{card.pendingVersion}</small> : card.availableVersion && card.availableVersion !== card.version && <small>{t("可用版本：", "Available release: ")}{card.availableVersion}</small>}
        {failureView(card, false)}
      </div>
      <div className={`${rows.cardEnd} ${css.rowActions}`}>{downloadFor(card)}{switchFor(card)}<span aria-hidden="true">›</span></div>
    </li>)}</ul>}
    <Modal open={confirm !== null} onClose={() => setConfirm(null)} title={confirm?.reopen ? t("立即更新？", "Update now?") : t("关闭插件视图？", "Close plugin views?")} closeLabel={t("关闭", "Close")} description={confirm?.reopen ? t("重新打开会清空撤销/重做历史。只有全部视图保存成功才会继续。", "Reopening clears undo/redo history. All views must save successfully before continuing.") : t("相关视图将在保存成功后关闭。工作区文件和插件数据不会删除。", "Related views close only after saving successfully. Workspace files and plugin data are retained.")} footer={<><Button variant="outline" onClick={() => setConfirm(null)}>{t("取消", "Cancel")}</Button><Button variant="primary" disabled={unavailableControls} onClick={() => { if (confirm) void operate(confirm.card, confirm.operation, confirm.reopen); }}>{t("继续", "Continue")}</Button></>} />
  </section>;
}
