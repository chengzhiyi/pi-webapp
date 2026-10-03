import { useEffect, useState } from "react";
import type { ConfigKind, ConfigScope, ConfigView, CustomProviderInput, LoginMethod, LoginView, ProviderModelChange, ProviderModelsView, ProviderView, UpdateStatus } from "./pi-bridge.ts";
import { PiProviderSettings } from "./PiProviderSettings.tsx";
import { AppearanceRow } from "./ui/settings/AppearanceRow.tsx";
import { LanguageRow } from "./ui/settings/LanguageRow.tsx";
import { UpdateRow } from "./ui/settings/UpdateRow.tsx";
import { SettingsPanel } from "./ui/settings/SettingsPanel.tsx";
import { useLocale, textFor } from "./ui/locale/preference.ts";
import { isPackageSource } from "../../shared/config-source.ts";
import "./pi-settings.css";

interface Props {
  onBack: () => void;
  setupMode?: boolean;
  getConfig: () => Promise<ConfigView>;
  updateConfig: (kind: ConfigKind, scope: ConfigScope, action: "add" | "remove", value: string) => Promise<ConfigView>;
  getUpdate: () => Promise<UpdateStatus>;
  getRunningVersion: (signal?: AbortSignal) => Promise<{ current: string | null }>;
  update: () => Promise<{ version: string }>;
  getProviders: () => Promise<ProviderView[]>;
  getProviderModels: (providerId: string) => Promise<ProviderModelsView>;
  updateProviderModel: (providerId: string, change: ProviderModelChange) => Promise<void>;
  logoutProvider: (providerId: string) => Promise<void>;
  addCustomProvider: (provider: CustomProviderInput) => Promise<void>;
  startProviderLogin: (providerId: string, method: LoginMethod) => Promise<{ id: string }>;
  getProviderLogin: (id: string) => Promise<LoginView>;
  getActiveProviderLogin: () => Promise<LoginView | null>;
  respondProviderLogin: (id: string, value: string) => Promise<void>;
  cancelProviderLogin: (id: string) => Promise<void>;
  refreshModels: () => Promise<void>;
}

type SectionId = "general" | "models" | ConfigKind;

export function PiSettings(props: Props) {
  const locale = useLocale();
  const t = (zh: string, en: string) => textFor(locale, zh, en);
  const resources: Array<{ kind: ConfigKind; title: string; hint: string; placeholder: string }> = [
    { kind: "packages", title: t("包与扩展", "Packages & extensions"), hint: t("包可以包含扩展和技能；本地扩展也可以单独加载。", "Packages can contain extensions and skills; local extensions can also be loaded separately."), placeholder: t("npm 包名、Git 地址或本地目录", "npm package, Git URL, or local directory") },
    { kind: "skills", title: t("技能", "Skills"), hint: t("Pi 已发现和加载的技能。", "Skills discovered and loaded by Pi."), placeholder: t("SKILL.md 文件或目录路径", "SKILL.md file or directory path") },
  ];
  const sections = [{ id: "general", label: t("通用设置", "General") }, { id: "models", label: t("模型", "Models") }, ...resources.map(({ kind, title }) => ({ id: kind, label: kind === "packages" ? t("包与扩展", "Packages") : title }))];
  const { onBack, getConfig, updateConfig } = props;
  const [config, setConfig] = useState<ConfigView | null>(null);
  const [drafts, setDrafts] = useState<Record<ConfigKind, string>>({ packages: "", extensions: "", skills: "" });
  const [active, setActive] = useState<SectionId>(props.setupMode ? "models" : "general");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => { if (props.setupMode) setActive("models"); }, [props.setupMode]);

  useEffect(() => {
    let alive = true;
    void getConfig().then((value) => { if (alive) setConfig(value); }).catch((cause) => {
      if (alive) setError(cause instanceof Error ? cause.message : t("无法读取 Pi 设置", "Could not load Pi settings"));
    }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const retryConfig = async () => {
    setLoading(true); setError("");
    try { setConfig(await getConfig()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("无法读取 Pi 设置", "Could not load Pi settings")); }
    finally { setLoading(false); }
  };
  const change = async (kind: ConfigKind, action: "add" | "remove", value: string) => {
    setBusy(true); setError("");
    try {
      setConfig(await updateConfig(kind, "global", action, value));
      if (action === "add") setDrafts((previous) => ({ ...previous, [kind]: "" }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("保存失败", "Save failed")); }
    finally { setBusy(false); }
  };

  const section = resources.find(({ kind }) => kind === active);
  const configured = section ? config?.global[section.kind] ?? [] : [];
  const installed = section ? config?.installed?.[section.kind] ?? [] : [];
  const draft = section ? drafts[section.kind].trim() : "";
  const misplacedSource = section?.kind !== "packages" && isPackageSource(draft);
  const packageSources = new Set(config?.installed.packages.map((item) => item.source) ?? []);
  const standaloneExtensions = config?.installed.extensions.filter((item) => !packageSources.has(item.source)) ?? [];
  const missingPackages = config?.global.packages.filter((source) => !packageSources.has(source)) ?? [];
  const extensionDraft = drafts.extensions.trim();
  const invalidExtensionDraft = isPackageSource(extensionDraft);
  const showInPackages = (source: string) => {
    setDrafts((previous) => ({ ...previous, packages: source }));
    setActive("packages");
    setError("");
  };
  return <SettingsPanel title={t("Pi 设置", "Pi Settings")} sections={sections} activeId={active} onSelect={(id) => { setActive(id as SectionId); setError(""); }} onClose={onBack}>
    {active === "general" && <div className="pi-settings-content"><h2>{t("通用设置", "General")}</h2><p className="pi-settings-intro">{t("调整网页的显示方式。", "Choose how the web interface appears.")}</p><div className="pi-settings-general"><LanguageRow /><AppearanceRow /><UpdateRow getUpdate={props.getUpdate} getRunningVersion={props.getRunningVersion} update={props.update} /></div></div>}
    {active === "models" && <PiProviderSettings setupMode={props.setupMode} onReturnToConversation={onBack} getProviders={props.getProviders} getProviderModels={props.getProviderModels} updateProviderModel={props.updateProviderModel} logoutProvider={props.logoutProvider} addCustomProvider={props.addCustomProvider} startLogin={props.startProviderLogin} getLogin={props.getProviderLogin} getActiveLogin={props.getActiveProviderLogin} respondLogin={props.respondProviderLogin} cancelLogin={props.cancelProviderLogin} refreshModels={props.refreshModels} />}
    {section && <div className="pi-settings-content" key={section.kind}>
      <h2>{section.title}</h2><p className="pi-settings-intro">{section.hint} {t("添加或移除后会重新加载 Pi 资源。", "Pi resources reload after you add or remove one.")}</p>
      {error && <p className="pi-settings-error" role="alert">{error}</p>}
      {!config ? loading ? <p role="status">{t("正在读取设置…", "Loading settings…")}</p> : <button className="pi-settings-retry" type="button" onClick={() => { void retryConfig(); }}>{t("重试读取设置", "Retry loading settings")}</button> : <>
        <section className="pi-settings-section" aria-label={`${t("已发现", "Discovered ")}${section.title}`}>
          <h3>{section.kind === "packages" ? t("已安装的包", "Installed packages") : t("已发现的技能", "Discovered skills")} <span>{installed.length}</span></h3>
          <ul>{installed.length ? installed.map((item) => {
            const included = section.kind === "packages" ? config.installed.extensions.filter((entry) => entry.source === item.source) : [];
            return <li key={`${item.path}:${item.source}`} className="pi-resource-item"><div className="pi-resource-main"><strong title={item.name}>{item.name}</strong><small title={item.path || item.source}>{item.path || item.source}</small>{included.length > 0 && <div className="pi-package-contents"><span>{t("包含扩展", "Includes extensions")}</span>{included.map((entry) => <span key={entry.path} title={entry.path}>{entry.name}</span>)}</div>}</div><div className="pi-resource-actions"><span className="pi-resource-meta">{item.enabled ? t("已启用", "Enabled") : t("已停用", "Disabled")} · {item.scope === "project" ? t("项目", "Project") : item.scope === "user" ? t("用户", "User") : t("临时", "Temporary")}</span>{section.kind === "packages" && config.global.packages.includes(item.source) && <button type="button" disabled={busy} onClick={() => { void change("packages", "remove", item.source); }}>{t("移除", "Remove")}</button>}</div></li>;
          }) : <li className="pi-settings-empty">{t("未发现", "No ")}{section.title}</li>}</ul>
        </section>
        {section.kind === "packages" && <section className="pi-settings-section" aria-label={t("独立扩展", "Standalone extensions")}>
          <h3>{t("独立扩展", "Standalone extensions")} <span>{standaloneExtensions.length}</span></h3>
          <ul>{standaloneExtensions.length ? standaloneExtensions.map((item) => <li key={item.path} className="pi-resource-item"><div className="pi-resource-main"><strong title={item.name}>{item.name}</strong><small title={item.path}>{item.path}</small></div><span className="pi-resource-meta">{item.enabled ? t("已启用", "Enabled") : t("已停用", "Disabled")} · {item.scope === "project" ? t("项目", "Project") : item.scope === "user" ? t("用户", "User") : t("临时", "Temporary")}</span></li>) : <li className="pi-settings-empty">{t("未发现独立扩展", "No standalone extensions found")}</li>}</ul>
        </section>}
        <section className="pi-settings-section" aria-label={`${t("手动配置", "Configure ")}${section.title}`}>
          <h3>{section.kind === "packages" ? t("添加包", "Add package") : t("手动配置技能", "Configure skills manually")}</h3>
          {(section.kind === "packages" ? missingPackages : configured).length > 0 && <ul>{(section.kind === "packages" ? missingPackages : configured).map((value) => <li key={value} className="pi-config-item"><div className="pi-resource-main"><code title={value}>{value}</code>{section.kind === "packages" && <small>{t("已配置，但未发现安装目录", "Configured, but installation directory was not found")}</small>}{section.kind !== "packages" && isPackageSource(value) && <small className="pi-config-warning">{t("未加载：包来源请在“包与扩展”中添加。", "Not loaded: add package sources under Packages & extensions.")}</small>}</div><div className="pi-resource-actions">{section.kind !== "packages" && isPackageSource(value) && <button type="button" disabled={busy} onClick={() => showInPackages(value)}>{t("转到包", "Go to packages")}</button>}<button type="button" disabled={busy} aria-label={`${t("移除", "Remove")} ${value}`} onClick={() => { void change(section.kind, "remove", value); }}>{t("移除", "Remove")}</button></div></li>)}</ul>}
          <form onSubmit={(event) => { event.preventDefault(); if (draft && !misplacedSource) void change(section.kind, "add", draft); }}>
            <input aria-label={`${t("添加", "Add ")}${section.title}`} aria-invalid={misplacedSource || undefined} aria-describedby={misplacedSource ? "pi-config-source-help" : undefined} placeholder={section.placeholder} value={drafts[section.kind]} onChange={(event) => setDrafts((previous) => ({ ...previous, [section.kind]: event.target.value }))} />
            <button type="submit" disabled={busy || !draft || misplacedSource}>{t("添加", "Add")}</button>
          </form>
          {misplacedSource && <p id="pi-config-source-help" className="pi-config-hint">{t("这是包来源，请在「包」中添加。", "This is a package source. Add it under Packages.")}<button type="button" onClick={() => showInPackages(draft)}>{t("转到包", "Go to packages")}</button></p>}
        </section>
        {section.kind === "packages" && <section className="pi-settings-section" aria-label={t("手动配置扩展路径", "Configure extension paths manually")}>
          <h3>{t("扩展路径", "Extension paths")}</h3>
          {config.global.extensions.length > 0 && <ul>{config.global.extensions.map((value) => <li key={value} className="pi-config-item"><div className="pi-resource-main"><code title={value}>{value}</code>{isPackageSource(value) && <small className="pi-config-warning">{t("未加载：包来源不能作为扩展路径，请在上方添加包。", "Not loaded: package sources cannot be extension paths. Add the package above.")}</small>}</div><div className="pi-resource-actions">{isPackageSource(value) && <button type="button" disabled={busy} onClick={() => showInPackages(value)}>{t("填入包", "Use as package")}</button>}<button type="button" disabled={busy} onClick={() => { void change("extensions", "remove", value); }}>{t("移除", "Remove")}</button></div></li>)}</ul>}
          <form onSubmit={(event) => { event.preventDefault(); if (extensionDraft && !invalidExtensionDraft) void change("extensions", "add", extensionDraft); }}><input aria-label={t("添加扩展路径", "Add extension path")} aria-invalid={invalidExtensionDraft || undefined} aria-describedby={invalidExtensionDraft ? "pi-extension-source-help" : undefined} placeholder={t("扩展文件或目录路径", "Extension file or directory path")} value={drafts.extensions} onChange={(event) => setDrafts((previous) => ({ ...previous, extensions: event.target.value }))} /><button type="submit" disabled={busy || !extensionDraft || invalidExtensionDraft}>{t("添加扩展", "Add extension")}</button></form>
          {invalidExtensionDraft && <p id="pi-extension-source-help" className="pi-config-hint">{t("这是包来源，请使用上方的“添加包”输入框。", "This is a package source. Use the Add package field above.")}<button type="button" onClick={() => showInPackages(extensionDraft)}>{t("填入包", "Use as package")}</button></p>}
        </section>}
      </>}
    </div>}
  </SettingsPanel>;
}
