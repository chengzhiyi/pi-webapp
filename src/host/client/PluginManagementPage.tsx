import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ManagedPlugin, PluginManagementView, PluginToggle } from "../../contracts/plugins.ts";
import { BUILTIN_IDS } from "../../contracts/plugins.ts";
import { useLocale, textFor } from "../../../web/src/ui/locale/preference.ts";
import { Modal } from "../../../web/src/ui/primitives/Modal.tsx";
import { FileTypeIcon } from "../../../web/src/ui/primitives/FileTypeIcon.tsx";
import { ExcalidrawIcon } from "../../../web/src/ui/primitives/ExcalidrawIcon.tsx";
import { IconBranchOutlineRegular } from "../../../web/src/ui/shared/primitives/icons/index.tsx";
import css from "./PluginManagementPage.module.css";
import { HostedPluginManagement } from "./hosted/management.tsx";

interface Props {
  getPluginManagement(): Promise<PluginManagementView>;
  togglePlugin(input: PluginToggle): Promise<PluginManagementView>;
  generation?: number;
  recovery?: ReactNode;
}
/** DSH-inspired package rows and detail navigation; switches only reflect acknowledged host state. */
export function PluginManagementPage({ getPluginManagement, togglePlugin, generation = 0, recovery }: Props) {
  const locale = useLocale();
  const t = (zh: string, en: string) => textFor(locale, zh, en);
  const localized = (value: string | { zh: string; en: string }) => typeof value === "string" ? value : value[locale];
  const [view, setView] = useState<PluginManagementView | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [hostedSelected, setHostedSelected] = useState<{ id: string; name: string } | null>(null);
  const [hostedBusy, setHostedBusy] = useState(false);
  const [hostedMatches, setHostedMatches] = useState(1);
  const [hostedReload, setHostedReload] = useState(0);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirm, setConfirm] = useState<ManagedPlugin | null>(null);
  const locked = useRef(false);
  const pendingRead = useRef(false);
  const observedGeneration = useRef(generation);
  const alive = useRef(true);
  const refresh = async (explicit = true) => {
    if (locked.current) { pendingRead.current = true; return; }
    locked.current = true; setLoading(true); if (explicit) { setError(""); setHostedReload(value => value + 1); }
    try { const next = await getPluginManagement(); if (alive.current) setView(next); }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : t("无法读取插件", "Could not load plugins")); }
    finally {
      locked.current = false; if (alive.current) setLoading(false);
      if (pendingRead.current && alive.current) { pendingRead.current = false; void refresh(false); }
    }
  };
  useEffect(() => { alive.current = true; void refresh(); return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (observedGeneration.current === generation) return;
    observedGeneration.current = generation;
    void refresh(false);
  }, [generation]);
  const change = async (plugin: ManagedPlugin) => {
    if (!view || locked.current) return;
    locked.current = true; setBusy(plugin.id); setError(""); setNotice(""); setConfirm(null);
    try {
      const next = await togglePlugin({ id: plugin.id, enabled: !plugin.enabled, expected: view.revision });
      if (alive.current) { setView(next); setNotice(t("插件配置已保存并生效", "Plugin settings saved and applied")); }
    } catch (cause) { if (alive.current) setError((cause instanceof Error ? cause.message : t("保存失败", "Could not save")) + t("。请刷新确认状态；操作不会自动重试。", ". Refresh to verify the state; this operation is not retried automatically.")); }
    finally {
      locked.current = false; if (alive.current) setBusy(null);
      if (pendingRead.current && alive.current) { pendingRead.current = false; void refresh(false); }
    }
  };
  const requestChange = (plugin: ManagedPlugin) => {
    if (plugin.id === BUILTIN_IDS.terminal && plugin.enabled) setConfirm(plugin);
    else void change(plugin);
  };
  const switchFor = (plugin: ManagedPlugin) => <button type="button" role="switch" className={css.switch} aria-label={t(`启用 ${localized(plugin.name)}`, `Enable ${localized(plugin.name)}`)} aria-checked={plugin.enabled} disabled={loading || busy !== null || hostedBusy || !plugin.managed} title={plugin.managed ? undefined : t("请在包与扩展中管理 Pi 运行时", "Manage the Pi runtime under Packages & extensions")} onClick={() => requestChange(plugin)}><span className={css.thumb} /></button>;
  const iconFor = (plugin: ManagedPlugin) => plugin.id === BUILTIN_IDS.git ? <IconBranchOutlineRegular size={30} /> : plugin.id === BUILTIN_IDS.terminal ? <span>›_</span> : plugin.id === BUILTIN_IDS.files ? <FileTypeIcon kind="folder" size={30} /> : plugin.id === BUILTIN_IDS.diagrams ? <ExcalidrawIcon size={30} /> : <span>◇</span>;
  const selectedPlugin = view?.items.find(plugin => plugin.id === selected);
  const shown = view?.items.filter(plugin => `${localized(plugin.name)} ${localized(plugin.description)} ${plugin.id}`.toLowerCase().includes(query.trim().toLowerCase())) ?? [];
  return <section className={css.page} data-plugin-panel aria-busy={loading || busy !== null}>
    <header className={css.pageHead}>
      <div>{(selectedPlugin || hostedSelected) && <div className={css.breadcrumb}><button type="button" onClick={() => { setSelected(null); setHostedSelected(null); }}>{t("‹ 插件", "‹ Plugins")}</button></div>}
        <h1>{selectedPlugin ? localized(selectedPlugin.name) : hostedSelected?.name ?? t("插件", "Plugins")}</h1>
        <p>{t("管理此服务的可选能力，按需启用。", "Manage optional capabilities on this service.")}</p></div>
      <button type="button" className={css.refresh} disabled={loading || busy !== null || hostedBusy} onClick={() => void refresh()} aria-label={t("刷新插件", "Refresh plugins")}>{loading ? "…" : "↻"}</button>
    </header>
    <p className={css.scope}>{t("全局设置 · 影响此服务的所有工作区和聊天；所有聊天空闲后才可修改。", "Global settings · Applies to every workspace and chat on this service. Changes require all chats to be idle.")}</p>
    {recovery}
    {error && <p className={css.error} role="alert">{error}</p>}
    {notice && <p className={css.notice} role="status">{notice}</p>}
    {loading && !view && <p role="status">{t("正在读取插件…", "Loading plugins…")}</p>}
    {!view && !loading && <button type="button" className={css.back} onClick={() => void refresh()}>{t("重试", "Retry")}</button>}
    {selectedPlugin ? <div className={css.detail}>
      <div className={css.detailHead}><span className={css.artwork} aria-hidden="true">{iconFor(selectedPlugin)}</span><div><strong>{localized(selectedPlugin.name)}</strong><p>{localized(selectedPlugin.description)}</p></div>{switchFor(selectedPlugin)}</div>
      <dl><dt>{t("插件标识", "Plugin ID")}</dt><dd><code>{selectedPlugin.id}</code></dd><dt>{t("来源", "Source")}</dt><dd>{selectedPlugin.kind === "builtin" ? t("随应用内置", "Bundled with the application") : t("Pi 软件包", "Pi package")}</dd><dt>{t("状态", "Status")}</dt><dd>{selectedPlugin.enabled ? t("已启用", "Enabled") : t("已停用", "Disabled")}</dd>{selectedPlugin.version && <><dt>{t("契约版本", "Contract version")}</dt><dd>{selectedPlugin.version}</dd></>}</dl>
      <p className={css.scope}>{selectedPlugin.managed ? t("停用会移除入口、关闭相关标签并阻止该插件的后端请求。不会删除工作区文件或聊天记录。", "Disabling removes entries, closes related tabs and blocks backend requests. Workspace files and chat history are not deleted.") : t("此插件的 Pi 运行时由软件包管理。当前协议未提供独立、安全卸载该运行时的能力，因此这里仅展示状态，不提供假开关。", "The Pi package owns this runtime. Its protocol does not expose independent safe teardown, so this page shows its status without a misleading toggle.")}</p>
      {selectedPlugin.id === BUILTIN_IDS.git && <p className={css.scope}>{t("关闭 Git 面板不禁止 Agent 或其他终端执行系统 git。", "Disabling the Git panel does not prevent an agent or another terminal from running system git.")}</p>}
    </div> : view && !hostedSelected && <>
      <input type="search" className={css.search} value={query} onChange={event => setQuery(event.target.value)} placeholder={t("搜索插件", "Search plugins")} aria-label={t("搜索插件", "Search plugins")} />
      {(["builtin", "external"] as const).map(kind => {
        const items = shown.filter(plugin => plugin.kind === kind);
        if (!items.length) return null;
        return <section className={css.group} key={kind}><h2>{kind === "builtin" ? t("内置能力", "Built-in capabilities") : t("已安装的 Web 插件", "Installed Web plugins")} <span>{items.length}</span></h2><ul className={css.cards}>{items.map(plugin => <li className={css.card} data-plugin-package={plugin.id} key={plugin.id}>
          <span className={css.artwork} aria-hidden="true">{iconFor(plugin)}</span>
          <div className={css.cardMain}><button className={css.cardOpen} type="button" onClick={() => setSelected(plugin.id)}>{localized(plugin.name)}</button><p>{localized(plugin.description)}</p><small><span className={css.dot} data-enabled={plugin.enabled} />{busy === plugin.id ? t("正在应用…", "Applying…") : plugin.enabled ? t("已启用", "Enabled") : t("已停用", "Disabled")}</small></div>
          <div className={css.cardEnd}>{switchFor(plugin)}<span aria-hidden="true">›</span></div>
        </li>)}</ul></section>;
      })}
      {!shown.length && !hostedMatches && <p className={css.scope}>{t("没有匹配的插件", "No matching plugins")}</p>}
    </>}
    <HostedPluginManagement locale={locale} generation={generation} reload={hostedReload} query={query} selectedId={hostedSelected?.id ?? null} visible={!selectedPlugin} disabled={loading || busy !== null} onSelect={setHostedSelected} onBusyChange={setHostedBusy} onMatchCountChange={setHostedMatches} />
    <Modal open={confirm !== null} onClose={() => setConfirm(null)} title={t("停用终端？", "Disable Terminal?")} closeLabel={t("关闭", "Close")} description={t("这会结束此服务所有聊天中的终端进程。未保存的 shell 工作可能丢失。", "This ends terminal processes in every chat on this service. Unsaved shell work may be lost.")} footer={<><button className={css.back} type="button" onClick={() => setConfirm(null)}>{t("取消", "Cancel")}</button><button className={css.danger} type="button" onClick={() => { if (confirm) void change(confirm); }}>{t("停用并结束终端", "Disable and stop terminals")}</button></>} />
  </section>;
}
