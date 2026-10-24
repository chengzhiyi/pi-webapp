import { useEffect, useState } from "react";
import { OFFICIAL_HOSTED_PLUGIN, type HostedPluginCard, type HostedPluginCatalog, type HostedManageOperation } from "../../../contracts/hosted-plugins.ts";
import { hostedApi } from "./api.ts";
import { ExcalidrawIcon } from "../../../../web/src/ui/primitives/ExcalidrawIcon.tsx";
import css from "./management.module.css";

/** Static official catalog survives offline/404; installed and enabled are never inferred from it. */
export function HostedPluginManagement({ locale, generation = 0 }: { locale: "zh" | "en"; generation?: number }) {
  const t = (zh: string, en: string) => locale === "zh" ? zh : en;
  const [catalog, setCatalog] = useState<HostedPluginCatalog>({ plugins: [OFFICIAL_HOSTED_PLUGIN], offline: true });
  const [known, setKnown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let alive = true; const abort = new AbortController();
    void hostedApi.catalog(abort.signal).then(value => { if (alive) { setCatalog(value); setKnown(true); setError(""); } }).catch(cause => { if (alive) { setError(String(cause)); setCatalog(previous => ({ ...previous, offline: true })); } });
    return () => { alive = false; abort.abort(); };
  }, [generation, reload]);
  const operate = async (card: HostedPluginCard, operation: HostedManageOperation, reopenEditors = false, updatePolicy?: HostedPluginCard["updatePolicy"]) => {
    if (busy) return;
    if ((operation === "disable" || operation === "uninstall") && !window.confirm(t("将关闭相关视图；仅在所有视图保存成功后继续。工作区文件不会删除。", "Related views will close only after every view saves successfully. Workspace files are retained."))) return;
    setBusy(true); setError(""); setNotice("");
    try {
      setCatalog(await hostedApi.manage({ pluginId: card.pluginId, operation, ...(updatePolicy ? { updatePolicy, ...(updatePolicy === "pinned" ? { version: card.version } : {}) } : {}), ...(reopenEditors ? { reopenEditors: true } : {}) })); setKnown(true);
      setNotice(t("已收到服务端确认；编辑器打开时更新默认等待关闭。", "Server acknowledged. Updates wait for open editors to close by default."));
      window.dispatchEvent(new Event("pi:hosted-catalog-changed"));
    } catch (cause) { setError(`${String(cause)}${t("；操作不会自动重试，请刷新确认状态。", "; no automatic retry. Refresh to verify state.")}`); }
    finally { setBusy(false); }
  };
  const cards = catalog.plugins.some(card => card.pluginId === OFFICIAL_HOSTED_PLUGIN.pluginId) ? catalog.plugins : [...catalog.plugins, OFFICIAL_HOSTED_PLUGIN];
  return <section className={css.section} data-hosted-management aria-busy={busy}>
    <h2>{t("托管插件", "Hosted plugins")}</h2>
    {catalog.offline && <p className={css.status} role="status">{t("离线目录 · 显示官方插件；安装状态须以服务端确认为准。", "Offline catalog · Official plugin shown; installation state requires server confirmation.")}</p>}
    {error && <p className={css.error} role="alert">{error}</p>}{notice && <p className={css.notice} role="status">{notice}</p>}
    <button type="button" disabled={busy} onClick={() => setReload(value => value + 1)}>{t("刷新 / 重试连接", "Refresh / retry connection")}</button>
    <ul className={css.cards}>{cards.map(card => <li className={css.card} key={card.pluginId} data-hosted-card={card.pluginId}>
      <div className={css.heading}><span className={css.artwork} aria-hidden="true"><ExcalidrawIcon size={26} /></span><div><h3>{card.name} {card.official && t("（官方）", "(Official)")}</h3><code>{card.pluginId}</code></div></div>
      <p className={css.status}>{!known ? t("安装状态未知 · 启用状态未知", "Installation unknown · Enablement unknown") : `${card.installed ? t("已安装", "Installed") : t("未安装", "Not installed")} · ${card.enabled ? t("已启用", "Enabled") : t("未启用", "Disabled")}`} {card.version}</p>
      {known && <label>{t("独立插件更新策略：", "Independent plugin update policy: ")}<select aria-label={t("插件更新策略", "Plugin update policy")} value={card.updatePolicy ?? "notify"} disabled={busy || !!catalog.offline} onChange={event => void operate(card, "policy", false, event.target.value as HostedPluginCard["updatePolicy"])}>
        <option value="notify">{t("仅检查并通知（默认）", "Check and notify only (default)")}</option>
        <option value="automatic">{t("自动更新已安装插件", "Automatically update installed plugin")}</option>
        <option value="pinned" disabled={!card.version}>{t("固定当前版本", "Pin current version")}{card.pinnedVersion ? ` (${card.pinnedVersion})` : ""}</option>
      </select></label>}
      <p className={css.status}>{t("宿主升级默认同步已安装的兼容稳定插件，与独立通知策略分开；固定版本需先解除固定。不安装缺席插件，不启用停用插件，不降级更高版本。更新等待编辑器关闭；离线保留兼容运行版本并在下次启动重试。独立检查无后台定时器。", "Host upgrades synchronize installed compatible stable plugins separately from independent notifications; pins require explicit change. Never installs absent plugins, enables disabled plugins, or downgrades higher versions. Updates wait for editor closure; offline keeps compatible code and retries next startup. Independent checks have no background timer.")}</p>
      {card.availableVersion && <p role="status">{t("可用兼容版本：", "Compatible release available: ")}{card.availableVersion}</p>}
      {card.updateDiagnostic && <p role="status">{card.updateDiagnostic.message} · {card.updateDiagnostic.checkedAt} · {card.updateDiagnostic.hostVersion}</p>}
      {card.error && /lock|owned/i.test(card.error) && <p>{t("锁恢复必须离线进行：停止全部主程序和插件进程，备份数据，再按 docs/hosted-update-recovery.md 检查并确认。此页面不会清锁。", "Lock recovery is offline only: stop all hosts and plugin processes, back up data, then inspect and confirm using docs/hosted-update-recovery.md. This page never clears locks.")}</p>}
      {card.pendingVersion && <p role="status">{t("待更新版本（请先关闭编辑器）：", "Pending version (close editors first): ")}{card.pendingVersion}</p>}
      {card.error && <p className={css.error} role="alert">{card.error}</p>}
      <div className={css.actions}>{(!known || !card.installed ? ["install"] : [card.enabled ? "disable" : "enable", "check", "update", "uninstall", "retry"]).map(operation => <button key={operation} type="button" disabled={busy || !known || !!catalog.offline} onClick={() => void operate(card, operation as HostedManageOperation)}>{({ install: t("安装", "Install"), enable: t("启用", "Enable"), disable: t("停用", "Disable"), check: t("检查更新", "Check updates"), update: t("更新（等待编辑器关闭）", "Update (wait for editors)"), uninstall: t("卸载", "Uninstall"), retry: t("重试", "Retry") } as Record<string, string>)[operation]}</button>)}
      {card.pendingVersion && <button type="button" disabled={busy || !!catalog.offline} onClick={() => {
        if (window.confirm(t("立即重新打开会清空原生撤销/重做历史。内容必须先同步，任何窗口忙碌或未确认都会保留旧版本。仍要继续？", "Immediate reopening clears native undo/redo history. All windows must flush first; busy or missing acknowledgements keep the old version. Continue?"))) void operate(card, "update", true);
      }}>{t("立即更新并重新打开（清空撤销历史）", "Update and reopen now (clears undo history)")}</button>}</div>
    </li>)}</ul>
  </section>;
}
