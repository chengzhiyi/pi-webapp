import { useEffect, useState } from "react";
import type { ConfigKind, ConfigScope, ConfigView, CustomProviderInput, LoginMethod, LoginView, ProviderView } from "./pi-bridge.ts";
import { PiProviderSettings } from "./PiProviderSettings.tsx";
import { AppearanceRow } from "./ui/settings/AppearanceRow.tsx";
import { SettingsPanel } from "./ui/settings/SettingsPanel.tsx";
import { isPackageSource } from "../../shared/config-source.ts";
import "./pi-settings.css";

interface Props {
  onBack: () => void;
  getConfig: () => Promise<ConfigView>;
  updateConfig: (kind: ConfigKind, scope: ConfigScope, action: "add" | "remove", value: string) => Promise<ConfigView>;
  getProviders: () => Promise<ProviderView[]>;
  addCustomProvider: (provider: CustomProviderInput) => Promise<void>;
  startProviderLogin: (providerId: string, method: LoginMethod) => Promise<{ id: string }>;
  getProviderLogin: (id: string) => Promise<LoginView>;
  respondProviderLogin: (id: string, value: string) => Promise<void>;
  cancelProviderLogin: (id: string) => Promise<void>;
  refreshModels: () => Promise<void>;
}

const resources: Array<{ kind: ConfigKind; title: string; hint: string; placeholder: string }> = [
  { kind: "packages", title: "包与扩展", hint: "包可以包含扩展和技能；本地扩展也可以单独加载。", placeholder: "npm 包名、Git 地址或本地目录" },
  { kind: "skills", title: "技能", hint: "Pi 已发现和加载的技能。", placeholder: "SKILL.md 文件或目录路径" },
];
type SectionId = "general" | "models" | ConfigKind;
const sections = [{ id: "general", label: "通用设置" }, { id: "models", label: "模型" }, ...resources.map(({ kind, title }) => ({ id: kind, label: title }))];

export function PiSettings(props: Props) {
  const { onBack, getConfig, updateConfig } = props;
  const [config, setConfig] = useState<ConfigView | null>(null);
  const [drafts, setDrafts] = useState<Record<ConfigKind, string>>({ packages: "", extensions: "", skills: "" });
  const [active, setActive] = useState<SectionId>("general");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    void getConfig().then((value) => { if (alive) setConfig(value); }).catch((cause) => {
      if (alive) setError(cause instanceof Error ? cause.message : "无法读取 Pi 设置");
    }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const retryConfig = async () => {
    setLoading(true); setError("");
    try { setConfig(await getConfig()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法读取 Pi 设置"); }
    finally { setLoading(false); }
  };
  const change = async (kind: ConfigKind, action: "add" | "remove", value: string) => {
    setBusy(true); setError("");
    try {
      setConfig(await updateConfig(kind, "global", action, value));
      if (action === "add") setDrafts((previous) => ({ ...previous, [kind]: "" }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败"); }
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
  return <SettingsPanel title="Pi 设置" sections={sections} activeId={active} onSelect={(id) => { setActive(id as SectionId); setError(""); }} onClose={onBack}>
    {active === "general" && <div className="pi-settings-content"><h2>通用设置</h2><p className="pi-settings-intro">调整网页的显示方式。</p><div className="pi-settings-general"><AppearanceRow /></div></div>}
    {active === "models" && <PiProviderSettings getProviders={props.getProviders} addCustomProvider={props.addCustomProvider} startLogin={props.startProviderLogin} getLogin={props.getProviderLogin} respondLogin={props.respondProviderLogin} cancelLogin={props.cancelProviderLogin} refreshModels={props.refreshModels} />}
    {section && <div className="pi-settings-content" key={section.kind}>
      <h2>{section.title}</h2><p className="pi-settings-intro">{section.hint} 添加或移除后会重新加载 Pi 资源。</p>
      {error && <p className="pi-settings-error" role="alert">{error}</p>}
      {!config ? loading ? <p role="status">正在读取设置…</p> : <button className="pi-settings-retry" type="button" onClick={() => { void retryConfig(); }}>重试读取设置</button> : <>
        <section className="pi-settings-section" aria-label={`已发现${section.title}`}>
          <h3>{section.kind === "packages" ? "已安装的包" : "已发现的技能"} <span>{installed.length}</span></h3>
          <ul>{installed.length ? installed.map((item) => {
            const included = section.kind === "packages" ? config.installed.extensions.filter((entry) => entry.source === item.source) : [];
            return <li key={`${item.path}:${item.source}`} className="pi-resource-item"><div className="pi-resource-main"><strong title={item.name}>{item.name}</strong><small title={item.path || item.source}>{item.path || item.source}</small>{included.length > 0 && <div className="pi-package-contents"><span>包含扩展</span>{included.map((entry) => <span key={entry.path} title={entry.path}>{entry.name}</span>)}</div>}</div><div className="pi-resource-actions"><span className="pi-resource-meta">{item.enabled ? "已启用" : "已停用"} · {item.scope === "project" ? "项目" : item.scope === "user" ? "用户" : "临时"}</span>{section.kind === "packages" && config.global.packages.includes(item.source) && <button type="button" disabled={busy} onClick={() => { void change("packages", "remove", item.source); }}>移除</button>}</div></li>;
          }) : <li className="pi-settings-empty">未发现{section.title}</li>}</ul>
        </section>
        {section.kind === "packages" && <section className="pi-settings-section" aria-label="独立扩展">
          <h3>独立扩展 <span>{standaloneExtensions.length}</span></h3>
          <ul>{standaloneExtensions.length ? standaloneExtensions.map((item) => <li key={item.path} className="pi-resource-item"><div className="pi-resource-main"><strong title={item.name}>{item.name}</strong><small title={item.path}>{item.path}</small></div><span className="pi-resource-meta">{item.enabled ? "已启用" : "已停用"} · {item.scope === "project" ? "项目" : item.scope === "user" ? "用户" : "临时"}</span></li>) : <li className="pi-settings-empty">未发现独立扩展</li>}</ul>
        </section>}
        <section className="pi-settings-section" aria-label={`手动配置${section.title}`}>
          <h3>{section.kind === "packages" ? "添加包" : "手动配置技能"}</h3>
          {(section.kind === "packages" ? missingPackages : configured).length > 0 && <ul>{(section.kind === "packages" ? missingPackages : configured).map((value) => <li key={value} className="pi-config-item"><div className="pi-resource-main"><code title={value}>{value}</code>{section.kind === "packages" && <small>已配置，但未发现安装目录</small>}{section.kind !== "packages" && isPackageSource(value) && <small className="pi-config-warning">未加载：包来源请在“包与扩展”中添加。</small>}</div><div className="pi-resource-actions">{section.kind !== "packages" && isPackageSource(value) && <button type="button" disabled={busy} onClick={() => showInPackages(value)}>转到包</button>}<button type="button" disabled={busy} aria-label={`移除 ${value}`} onClick={() => { void change(section.kind, "remove", value); }}>移除</button></div></li>)}</ul>}
          <form onSubmit={(event) => { event.preventDefault(); if (draft && !misplacedSource) void change(section.kind, "add", draft); }}>
            <input aria-label={`添加${section.title}`} aria-invalid={misplacedSource || undefined} aria-describedby={misplacedSource ? "pi-config-source-help" : undefined} placeholder={section.placeholder} value={drafts[section.kind]} onChange={(event) => setDrafts((previous) => ({ ...previous, [section.kind]: event.target.value }))} />
            <button type="submit" disabled={busy || !draft || misplacedSource}>添加</button>
          </form>
          {misplacedSource && <p id="pi-config-source-help" className="pi-config-hint">这是包来源，请在「包」中添加。<button type="button" onClick={() => showInPackages(draft)}>转到包</button></p>}
        </section>
        {section.kind === "packages" && <section className="pi-settings-section" aria-label="手动配置扩展路径">
          <h3>扩展路径</h3>
          {config.global.extensions.length > 0 && <ul>{config.global.extensions.map((value) => <li key={value} className="pi-config-item"><div className="pi-resource-main"><code title={value}>{value}</code>{isPackageSource(value) && <small className="pi-config-warning">未加载：包来源不能作为扩展路径，请在上方添加包。</small>}</div><div className="pi-resource-actions">{isPackageSource(value) && <button type="button" disabled={busy} onClick={() => showInPackages(value)}>填入包</button>}<button type="button" disabled={busy} onClick={() => { void change("extensions", "remove", value); }}>移除</button></div></li>)}</ul>}
          <form onSubmit={(event) => { event.preventDefault(); if (extensionDraft && !invalidExtensionDraft) void change("extensions", "add", extensionDraft); }}><input aria-label="添加扩展路径" aria-invalid={invalidExtensionDraft || undefined} aria-describedby={invalidExtensionDraft ? "pi-extension-source-help" : undefined} placeholder="扩展文件或目录路径" value={drafts.extensions} onChange={(event) => setDrafts((previous) => ({ ...previous, extensions: event.target.value }))} /><button type="submit" disabled={busy || !extensionDraft || invalidExtensionDraft}>添加扩展</button></form>
          {invalidExtensionDraft && <p id="pi-extension-source-help" className="pi-config-hint">这是包来源，请使用上方的“添加包”输入框。<button type="button" onClick={() => showInPackages(extensionDraft)}>填入包</button></p>}
        </section>}
      </>}
    </div>}
  </SettingsPanel>;
}
