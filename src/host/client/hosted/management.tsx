import { useEffect, useRef, useState } from "react";
import { OFFICIAL_HOSTED_PLUGIN, type HostedPluginCard, type HostedPluginCatalog, type HostedManageOperation } from "../../../contracts/hosted-plugins.ts";
import { hostedApi } from "./api.ts";
import { PendingViews } from "./PendingViews.tsx";
import { HostedPluginIcon } from "./PluginIcon.tsx";
import { Button } from "../../../../web/src/ui/primitives/Button.tsx";
import { Modal } from "../../../../web/src/ui/primitives/Modal.tsx";
import { showToast } from "../../../../web/src/ui/primitives/Toast.tsx";
import { writeClipboard } from "../../../../web/src/ui/shared/primitives/clipboard.ts";
import rows from "../PluginManagementPage.module.css";
import css from "./management.module.css";
import { managementConfirmation, type ConfirmationOperation } from "./confirmation.ts";

/** Browser sign-in (device flow) when the host supports it, else a pre-filled GitHub token page; a pasted token is always accepted. Values are write-only. */
function SecretsSection({ card, t, onCatalog, disabled }: { card: HostedPluginCard; t: (zh: string, en: string) => string; onCatalog(next: HostedPluginCatalog): void; disabled: boolean }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [flow, setFlow] = useState<{ name: string; deviceId: string; userCode: string; verificationUri: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!flow) return;
    let stop = false;
    const tick = async () => {
      while (!stop && alive.current) {
        await new Promise(resolve => setTimeout(resolve, 3000));
        if (stop || !alive.current) return;
        try {
          const result = await hostedApi.signIn({ auth: "poll", deviceId: flow.deviceId });
          if (result.status === "granted" && result.catalog) { onCatalog(result.catalog); setFlow(null); setMessage(t("已授权。", "Authorized.")); return; }
          if (result.status === "denied" || result.status === "expired") { setFlow(null); setMessage(result.status === "denied" ? t("授权已被拒绝。", "Authorization was denied.") : t("授权已过期，请重试。", "Authorization expired. Try again.")); return; }
        } catch (cause) { setFlow(null); setMessage(cause instanceof Error ? cause.message : String(cause)); return; }
      }
    };
    void tick();
    return () => { stop = true; };
  }, [flow]);
  if (!card.secrets?.length) return null;
  const save = async (name: string, value: string | null) => {
    setMessage("");
    try { onCatalog(await hostedApi.secret(card.pluginId, name, value)); setValues(previous => ({ ...previous, [name]: "" })); setMessage(value === null ? t("已移除。", "Removed.") : t("已保存。", "Saved.")); }
    catch (cause) { setMessage(cause instanceof Error ? cause.message : String(cause)); }
  };
  const start = async (name: string) => {
    setMessage("");
    try {
      const started = await hostedApi.signIn({ auth: "start", pluginId: card.pluginId, name });
      setCopied(false);
      setFlow({ name, deviceId: started.deviceId, userCode: started.userCode, verificationUri: started.verificationUri });
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : String(cause)); }
  };
  const copyCode = async (code: string) => {
    setCopied(await writeClipboard(code));
  };
  const copyAndOpen = (f: { userCode: string; verificationUri: string }) => {
    window.open(f.verificationUri, "_blank", "noopener,noreferrer");
    void copyCode(f.userCode);
  };
  const cancel = () => { if (flow) void hostedApi.signIn({ auth: "cancel", deviceId: flow.deviceId }).catch(() => {}); setFlow(null); };
  return <section className={css.configuration}><h2>{t("GitHub 授权", "GitHub authorization")}</h2>
    <p className={rows.scope}>{t("令牌只保存在本机，由主程序代为发起请求；插件进程和页面永远读不到它。", "The token is stored on this machine and used by the host on the plugin's behalf; plugin code and pages can never read it.")}</p>
    {card.secrets.map(secret => <div key={secret.name} className={css.configuration}>
      <div className={css.actions}>
        <span role="status">{secret.configured ? t("已授权", "Authorized") : t("未授权", "Not authorized")}</span>
        {secret.signIn === "browser" && <Button variant="outline" size="sm" disabled={disabled || !!flow} onClick={() => void start(secret.name)}>{secret.configured ? t("重新授权", "Re-authorize") : t("在浏览器中授权 GitHub", "Authorize with GitHub")}</Button>}
        {secret.signIn === "token-page" && secret.createUrl && <Button variant="outline" size="sm" disabled={disabled} onClick={() => window.open(secret.createUrl, "_blank", "noopener,noreferrer")}>{t("打开 GitHub 创建令牌", "Open GitHub to create a token")}</Button>}
        {secret.configured && <Button variant="outline" size="sm" disabled={disabled} onClick={() => void save(secret.name, null)}>{t("移除", "Remove")}</Button>}
      </div>
      {flow?.name === secret.name && <div className={rows.scope} role="status">
        <ol style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 10 }}>
          <li>{t("复制下面的验证码", "Copy this code")}
            <div className={css.actions} style={{ marginTop: 6 }}>
              <code style={{ fontSize: 28, letterSpacing: 4, fontWeight: 600, padding: "6px 14px", border: "1px solid currentColor", borderRadius: 8, userSelect: "all" }}>{flow.userCode}</code>
              <Button variant="outline" size="sm" onClick={() => void copyCode(flow.userCode)}>{copied ? t("已复制", "Copied") : t("复制", "Copy")}</Button>
            </div>
          </li>
          <li>{t("打开 GitHub 授权页，粘贴验证码并点击 Authorize", "Open GitHub, paste the code and click Authorize")}
            <div className={css.actions} style={{ marginTop: 6 }}>
              <Button size="sm" onClick={() => copyAndOpen(flow)}>{t("复制验证码并打开 GitHub", "Copy code and open GitHub")}</Button>
            </div>
          </li>
        </ol>
        <div className={css.actions} style={{ marginTop: 10 }}>
          <span>{t("等待授权中… 完成后这里会自动更新。", "Waiting for authorization… this updates automatically.")}</span>
          <Button variant="outline" size="sm" onClick={cancel}>{t("取消", "Cancel")}</Button>
        </div>
      </div>}
      <details open={secret.signIn === "token-page" && !secret.configured}><summary>{secret.signIn === "token-page" ? t("创建后在此粘贴令牌（仅限目标仓库的 fine-grained token，Issues、Pull requests、Contents 读写）", "Paste the token here after creating it (fine-grained, limited to the target repository, Issues / Pull requests / Contents read-write)") : t("改用手动粘贴令牌", "Paste a token instead")}</summary>
        <div className={css.actions}>
          <input type="password" autoComplete="off" aria-label={secret.name} value={values[secret.name] ?? ""} onChange={event => setValues(previous => ({ ...previous, [secret.name]: event.target.value }))} />
          <Button variant="outline" size="sm" disabled={disabled || !(values[secret.name] ?? "").trim()} onClick={() => void save(secret.name, (values[secret.name] ?? "").trim())}>{t("保存", "Save")}</Button>
        </div>
      </details>
    </div>)}
    {message && <p role="status" className={rows.scope}>{message}</p>}
  </section>;
}

type Problem = { code?: string; message: string };
/** One actionable message per failure; raw diagnostics remain inspectable, not repeated. */
function problemText(problem: Problem, installed: boolean, t: (zh: string, en: string) => string) {
  const messages: Record<string, string> = {
    metadata_not_found: t("官方插件暂未发布，暂不可安装。稍后可重新检查。", "The official package is not currently published. Check again later."),
    tarball_not_found: t("发行文件暂不可用。请重新检查或稍后重试。", "The release file is unavailable. Check again or retry later."),
    no_compatible_version: t("暂无适用于此软件版本的插件。稍后可重新检查。", "No compatible release for this app version. Check again later."),
    registry_unreachable: t("暂时无法访问下载服务。请检查网络后重试。", "Cannot reach the download service. Check your network and retry."),
    download_cancelled: t("下载已取消。", "Download cancelled."),
    view_barrier: t("尚未完成所有视图的保存确认，操作已停止。请先处理本页的刷新前视图记录，并检查仍打开的编辑器，然后重试。", "Save confirmation is still pending for some views, so the operation stopped. Review previous-view records on this page and any open editors, then retry."),
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
  // Older hosts do not report retained-data metadata. Remember installations
  // observed by this management page without assuming an operation succeeded.
  const seenInstalled = useRef(new Set<string>());
  useEffect(() => { for (const card of catalog.plugins) if (card.installed) seenInstalled.current.add(card.pluginId); }, [catalog]);
  const [download, setDownload] = useState<{ pluginId: string; id: string } | null>(null);
  const [error, setError] = useState<Problem | null>(null);
  const [operationError, setOperationError] = useState<{ id: string; problem: Problem } | null>(null);
  const [notice, setNotice] = useState("");
  const [retryRead, setRetryRead] = useState(0);
  const [confirm, setConfirm] = useState<{ card: HostedPluginCard; operation: ConfirmationOperation; reopen?: boolean } | null>(null);
  const confirmation = confirm ? managementConfirmation(confirm.operation, locale, confirm.card.name) : null;
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
      try { setCatalog(await hostedApi.catalog()); setKnown(true); window.dispatchEvent(new Event("pi:hosted-catalog-changed")); } catch { /* keep the operation failure visible */ }
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
    return card.contribution?.entry.description[locale] ?? card.description?.[locale] ?? (card.pluginId === OFFICIAL_HOSTED_PLUGIN.pluginId
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
    return <Button variant="outline" size="sm" disabled={unavailableControls || unavailable} onClick={() => request(card, card.pendingVersion ? "retry" : card.installed ? "update" : "install")}>{card.pendingVersion ? t("应用待更新版本", "Apply pending update") : card.installed ? t("更新", "Update") : unavailable ? t("暂不可下载", "Unavailable") : card.hasRetainedData || seenInstalled.current.has(card.pluginId) ? t("重新安装", "Reinstall") : t("下载", "Download")}</Button>;
  };
  // On the list, operation failures go to the app-wide toast stack; rows keep a one-word marker
  // and the detail page keeps the full diagnostics, so errors never reflow the list layout.
  useEffect(() => {
    if (!operationError || selected) return;
    const card = cards.find(item => item.pluginId === operationError.id);
    showToast({ key: `hosted-operation-${operationError.id}`, message: `${card ? `${name(card)}：` : ""}${problemText(operationError.problem, !!card?.installed, t)}`, detail: [operationError.problem.code, operationError.problem.message].filter(Boolean).join(": "), detailLabel: t("诊断信息", "Diagnostics") });
  }, [operationError]);
  const failureView = (card: HostedPluginCard, detail: boolean) => {
    const failure = failureFor(card), diagnostic = card.updateDiagnostic;
    if (!failure) return null;
    return <div className={css.error} role="alert">{problemText(failure, card.installed, t)}{detail && <details><summary>{t("诊断信息", "Diagnostics")}</summary><code>{failure.code}</code><p>{failure.message}</p>{diagnostic && <p>{diagnostic.checkedAt} · {diagnostic.hostVersion}</p>}{/lock|owned/i.test(failure.message) && <p>{t("停止所有程序并备份后，按 docs/hosted-update-recovery.md 恢复。此页面不会清锁。", "Stop all hosts and back up data before following docs/hosted-update-recovery.md. This page never clears locks.")}</p>}</details>}{detail && failure.code === "view_barrier" && <PendingViews pluginId={card.pluginId} t={t} />}</div>;
  };
  return <section className={css.section} data-hosted-management aria-busy={busy || reading} style={!visible ? { display: "none" } : undefined}>
    {!selected && <h2 className={rows.groupTitle}>{t("官方插件", "Official plugins")}</h2>}
    {error && <div role="alert" className={css.error}>{t("无法读取插件状态，请重试。", "Cannot read plugin status. Please retry.")}<details><summary>{t("诊断信息", "Diagnostics")}</summary>{error.message}</details><Button variant="outline" size="sm" disabled={busy || reading || disabled} onClick={() => setRetryRead(value => value + 1)}>{t("重试", "Retry")}</Button></div>}
    {catalog.dev && <div data-hosted-dev>
      {catalog.dev.notices.map((item, index) => <div key={index} className={item.level === "info" ? css.notice : css.error} role={item.level === "error" ? "alert" : "status"}><strong>{t("开发模式", "Dev mode")}{item.pluginId ? ` · ${item.pluginId}` : ""}</strong>: {item.message}</div>)}
      {catalog.dev.sources.map(source => <p key={source.pluginId} className={css.notice} role="status" data-hosted-dev-source={source.pluginId}>{t("开发目录", "Dev directory")} · <code>{source.root}</code> · {source.state}{source.version ? ` ${source.version}` : ""}{source.message ? ` — ${source.message}` : ""}</p>)}
    </div>}
    {notice && <p className={css.notice} role="status">{notice}</p>}
    {download && <Button variant="outline" onClick={() => {
      void hostedApi.manage({ pluginId: download.pluginId, operation: "cancel-download", downloadId: download.id }).then(() => setNotice(t("已请求取消，已完成的安装不会回滚。", "Cancellation requested; committed installations are not rolled back."))).catch(cause => setOperationError({ id: download.pluginId, problem: problem(cause) }));
    }}>{t("取消下载（不回滚已提交安装）", "Cancel download (no rollback after commit)")}</Button>}
    {selected ? <div className={rows.detail} data-hosted-detail={selected.pluginId}>
      <div className={rows.detailHead}><span className={rows.artwork} aria-hidden="true"><HostedPluginIcon card={selected} size={30} /></span>{switchFor(selected)}</div>
      <div className={rows.detailMain}>
        <div className={rows.titleRow}><h1>{selected.name}</h1>{selected.official && <span className={rows.tag} data-tone="info">{t("官方", "Official")}</span>}{selected.version && <span className={rows.tag}>v{selected.version}</span>}{failureFor(selected) && <span className={rows.tag} data-tone="danger">{t("需要处理", "Needs attention")}</span>}</div>
        <p className={rows.detailDesc}>{description(selected)}</p>
        <p className={rows.detailName}><code>{selected.pluginId}</code></p>
      </div>
      {failureView(selected, true)}
      <section className={rows.detailSection}><h2>{t("详细信息", "Details")}</h2>
        <dl><dt>{t("来源", "Source")}</dt><dd>{t("按需下载的官方插件", "Official on-demand package")}</dd><dt>{t("状态", "Status")}</dt><dd>{status(selected)}</dd>{selected.availableVersion && <><dt>{t("可用版本", "Available release")}</dt><dd>{selected.availableVersion}</dd></>}{selected.pendingVersion && <><dt>{t("待更新版本", "Pending release")}</dt><dd>{selected.pendingVersion}</dd></>}</dl>
      </section>
      <SecretsSection card={selected} t={t} disabled={unavailableControls} onCatalog={next => { setCatalog(next); window.dispatchEvent(new Event("pi:hosted-catalog-changed")); }} />
      <section className={`${css.configuration} ${rows.detailSection}`}><h2>{t("配置与更新", "Configuration & updates")}</h2>
        <p className={rows.scope}>{selected.icon === "drawing" || selected.pluginId === OFFICIAL_HOSTED_PLUGIN.pluginId ? t("无需额外配置。启用后，可从工作区侧栏打开，也可查看对话中的图稿。图稿保存在工作区，停用或卸载不会删除文件和插件数据。", "No additional configuration is required. Once enabled, open it from the workspace sidebar or view diagrams in conversations. Disabling or uninstalling retains workspace files and plugin data.") : t("启用后从工作区侧栏打开。停用或卸载不会删除插件数据。", "Once enabled, open it from the workspace sidebar. Disabling or uninstalling retains plugin data.")}</p>
        <p className={rows.scope}>{t("兼容的插件可独立更新；软件升级仅在协议不兼容时协调插件版本。", "Compatible plugins update independently. App upgrades coordinate plugins only when their protocol is incompatible.")}</p>
        <p className={rows.scope}>{t("停用或卸载前会先保存并关闭相关视图；保存失败时不会继续。", "Disabling or uninstalling first saves and closes related views; a failed save stops the operation.")}</p>
        {selected.pendingVersion && <p className={rows.scope} role="status">{t("关闭编辑器后更新至：", "Close editors to update to: ")}{selected.pendingVersion}</p>}
        {!failureFor(selected) && selected.updateDiagnostic?.status === "up-to-date" && !selected.pendingVersion && <p className={rows.scope}>{t("兼容版本检查已完成。", "Compatible release check complete.")}</p>}
        <div className={css.actions}>{downloadFor(selected)}<Button variant="outline" size="sm" disabled={unavailableControls} onClick={() => request(selected, "check")}>{t("检查更新", "Check updates")}</Button>
          {selected.installed && <Button variant="outline" size="sm" disabled={unavailableControls} onClick={() => request(selected, "uninstall")}>{t("卸载", "Uninstall")}</Button>}
          {selected.pendingVersion && <Button variant="outline" size="sm" disabled={unavailableControls} onClick={() => setConfirm({ card: selected, operation: "update", reopen: true })}>{t("立即更新并重新打开", "Update and reopen now")}</Button>}
        </div>
      </section>
    </div> : <ul className={rows.cards}>{shown.map(card => <li className={rows.card} key={card.pluginId} data-hosted-card={card.pluginId}>
      <span className={rows.artwork} aria-hidden="true"><HostedPluginIcon card={card} size={30} /></span>
      <div className={rows.cardMain}><div className={rows.titleRow}><button className={rows.cardOpen} type="button" onClick={() => onSelect({ id: card.pluginId, name: card.name })}>{name(card)}</button>
          <span className={rows.tag} data-tone={busy ? "info" : undefined}>{busy ? t("正在应用…", "Applying…") : status(card)}</span>
          {!busy && failureFor(card) && <span className={rows.tag} data-tone="danger">{t("需要处理", "Needs attention")}</span>}
          {card.pendingVersion ? <span className={rows.tag} data-tone="info">{t("关闭编辑器后更新至：", "Close editors to update to: ")}{card.pendingVersion}</span> : card.availableVersion && card.availableVersion !== card.version && <span className={rows.tag} data-tone="info">{t("可用版本：", "Available release: ")}{card.availableVersion}</span>}
        </div><p>{description(card)}</p>
      </div>
      <div className={`${rows.cardEnd} ${css.rowActions}`}>{downloadFor(card)}{switchFor(card)}</div>
    </li>)}</ul>}
    <Modal open={confirm !== null} onClose={() => setConfirm(null)} title={confirmation?.title ?? ""} closeLabel={t("关闭", "Close")} description={confirmation?.description} footer={<><Button variant="outline" onClick={() => setConfirm(null)}>{t("取消", "Cancel")}</Button><Button variant="primary" disabled={unavailableControls} onClick={() => { if (confirm) void operate(confirm.card, confirm.operation, confirm.reopen); }}>{confirmation?.confirm}</Button></>} />
  </section>;
}
