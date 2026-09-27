import { useEffect, useRef, useState } from "react";
import { localize as t } from "./ui/locale/preference.ts";
import type { CustomProviderInput, LoginMethod, LoginView, ProviderModelChange, ProviderModelsView, ProviderView } from "./pi-bridge.ts";
import { PiProviderModelsEditor } from "./PiProviderModelsEditor.tsx";

interface Props {
  setupMode?: boolean;
  onReturnToConversation: () => void;
  getProviders: () => Promise<ProviderView[]>;
  getProviderModels: (providerId: string) => Promise<ProviderModelsView>;
  updateProviderModel: (providerId: string, change: ProviderModelChange) => Promise<void>;
  logoutProvider: (providerId: string) => Promise<void>;
  addCustomProvider: (provider: CustomProviderInput) => Promise<void>;
  startLogin: (providerId: string, method: LoginMethod, initialSecret?: string) => Promise<{ id: string }>;
  getLogin: (id: string) => Promise<LoginView>;
  getActiveLogin: () => Promise<LoginView | null>;
  respondLogin: (id: string, value: string) => Promise<void>;
  cancelLogin: (id: string) => Promise<void>;
  refreshModels: () => Promise<void>;
}

const emptyCustom: CustomProviderInput = { id: "", name: "", baseUrl: "", api: "openai-completions", modelId: "" };

function safeUrl(value: string): string | null {
  try { const url = new URL(value); return url.protocol === "https:" || url.protocol === "http:" ? url.href : null; }
  catch { return null; }
}

function reserveAuthWindow(): Window | null {
  let popup: Window | null = null;
  try {
    popup = window.open("about:blank", "_blank");
    if (popup) {
      popup.opener = null;
      popup.document.title = t("正在准备授权页面", "Preparing sign-in");
      popup.document.body.textContent = t("正在准备授权页面…", "Preparing sign-in…");
    }
    return popup;
  } catch { popup?.close(); return null; }
}

function ApiKeyForm({ provider, configured, busy, getProviderModels, updateProviderModel, onConnect }: {
  provider: ProviderView; configured: boolean; busy: boolean;
  getProviderModels: Props["getProviderModels"]; updateProviderModel: Props["updateProviderModel"];
  onConnect: (key: string) => Promise<void>;
}) {
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [savedBaseUrl, setSavedBaseUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    setLoading(true);
    void getProviderModels(provider.id).then((view) => {
      if (alive) { setBaseUrl(view.baseUrl ?? ""); setSavedBaseUrl(view.baseUrl ?? ""); setLoading(false); }
    }).catch((cause) => { if (alive) { setLoading(false); setError(cause instanceof Error ? cause.message : t("无法读取 API 地址", "Could not load API URL")); } });
    return () => { alive = false; };
  }, [provider.id]);
  const submit = async () => {
    const secret = key.trim();
    const endpoint = baseUrl.trim();
    if (!secret && !configured) return;
    if (endpoint && !safeUrl(endpoint)) { setError(t("请输入有效的 http 或 https 地址。", "Enter a valid HTTP or HTTPS URL.")); return; }
    setSaving(true); setError("");
    try {
      if (endpoint !== savedBaseUrl) {
        await updateProviderModel(provider.id, { action: "base_url", baseUrl: endpoint || null });
        setSavedBaseUrl(endpoint);
      }
      if (secret) { setKey(""); await onConnect(secret); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("保存失败", "Could not save")); }
    finally { setSaving(false); }
  };
  return <form className="pi-provider-key-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <label>{t("API Key", "API key")}<input type="password" autoComplete="off" maxLength={16384} value={key} onChange={(event) => setKey(event.target.value)} placeholder={configured ? t("已配置，输入新值可替换", "Configured; enter a new key to replace") : t("输入 API Key", "Enter API key")} /></label>
    <details className="pi-provider-advanced"><summary>{t("自定义设置", "Custom settings")}</summary><label>{t("API 地址（可选）", "API URL (optional)")}<input type="url" maxLength={2048} value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder={t("使用提供方默认地址", "Use provider default URL")} /></label></details>
    <button type="submit" disabled={busy || saving || loading || (!key.trim() && (baseUrl.trim() === savedBaseUrl || !configured))}>{saving ? t("保存中…", "Saving…") : configured ? t("保存", "Save") : t("连接", "Connect")}</button>
    {error && <p className="pi-settings-error" role="alert">{error}</p>}
  </form>;
}

export function PiProviderSettings({ setupMode = false, onReturnToConversation, getProviders, getProviderModels, updateProviderModel, logoutProvider, addCustomProvider, startLogin, getLogin, getActiveLogin, respondLogin, cancelLogin, refreshModels }: Props) {
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [adding, setAdding] = useState<"builtin" | "custom" | null>(setupMode ? "builtin" : null);
  const [selected, setSelected] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [logoutTarget, setLogoutTarget] = useState<string | null>(null);
  const [custom, setCustom] = useState<CustomProviderInput>(emptyCustom);
  const [flow, setFlow] = useState<LoginView | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pendingAuthWindow = useRef<{ id: string | null; popup: Window | null } | null>(null);

  useEffect(() => { if (setupMode) setAdding((current) => current ?? "builtin"); }, [setupMode]);

  useEffect(() => {
    let alive = true;
    void getActiveLogin().then((active) => { if (alive && active) setFlow((current) => current ?? active); }).catch(() => {});
    return () => { alive = false; pendingAuthWindow.current?.popup?.close(); };
  }, []);

  const reload = async () => { setProviders(await getProviders()); setLoaded(true); };
  const acceptLoginView = async (next: LoginView) => {
    const pending = pendingAuthWindow.current;
    const authorization = next.authorization ?? (next.event?.type === "auth_url" || next.event?.type === "device_code" ? next.event : undefined);
    if (pending?.id === next.id && authorization) {
      const url = safeUrl(authorization.type === "auth_url" ? authorization.url : authorization.verificationUri);
      if (url) {
        try {
          if (pending.popup && !pending.popup.closed) pending.popup.location.replace(url);
          else window.open(url, "_blank", "noopener,noreferrer");
        } catch { pending.popup?.close(); }
        pendingAuthWindow.current = null;
      }
    }
    if (pending?.id === next.id && (next.status === "done" || next.status === "error" || next.status === "cancelled")) {
      pending.popup?.close();
      pendingAuthWindow.current = null;
    }
    setFlow(next);
    if (next.status === "done") {
      setAdding(null); setEditing(null);
      await Promise.all([reload(), refreshModels()]);
    }
  };
  useEffect(() => { void reload().catch((cause) => { setLoaded(true); setError(cause instanceof Error ? cause.message : t("无法读取模型提供方", "Could not load model providers")); }); }, []);
  useEffect(() => {
    if (!flow || flow.status === "done" || flow.status === "error" || flow.status === "cancelled") return;
    let alive = true;
    const timer = window.setInterval(() => {
      void getLogin(flow.id).then(async (next) => {
        if (!alive) return;
        await acceptLoginView(next);
      }).catch((cause) => { if (alive) setError(cause instanceof Error ? cause.message : t("登录状态不可用", "Login status is unavailable")); });
    }, 700);
    return () => { alive = false; window.clearInterval(timer); };
  }, [flow?.id, flow?.status]);

  const loginBusy = busy || flow?.status === "running" || flow?.status === "waiting";
  const flowProviderName = providers.find((provider) => provider.id === flow?.providerId)?.name;
  const configured = providers.filter((provider) => provider.configured);
  const addable = providers.filter((provider) => !provider.configured && provider.methods.length > 0);
  const selectedProvider = addable.find((provider) => provider.id === selected)
    ?? (setupMode ? addable.find((provider) => provider.id === "openai-codex") ?? addable.find((provider) => provider.methods.includes("oauth")) : undefined)
    ?? addable.find((provider) => provider.id === "openai")
    ?? addable[0];

  const begin = async (providerId: string, method: LoginMethod, initialSecret?: string) => {
    pendingAuthWindow.current = method === "oauth" ? { id: null, popup: reserveAuthWindow() } : null;
    setBusy(true); setError(""); setDraft("");
    try {
      const { id } = await startLogin(providerId, method, initialSecret);
      if (pendingAuthWindow.current) pendingAuthWindow.current.id = id;
      await acceptLoginView(await getLogin(id));
    }
    catch (cause) {
      pendingAuthWindow.current?.popup?.close(); pendingAuthWindow.current = null;
      setError(cause instanceof Error ? cause.message : t("无法开始登录", "Could not start sign-in"));
      if (!flow) void getActiveLogin().then((active) => { if (active) setFlow(active); }).catch(() => {});
    }
    finally { setBusy(false); }
  };
  const submit = async (value: string) => {
    if (!flow) return;
    setBusy(true); setError("");
    try { await respondLogin(flow.id, value); setDraft(""); await acceptLoginView(await getLogin(flow.id)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("提交失败", "Submission failed")); }
    finally { setBusy(false); }
  };
  const createCustom = async () => {
    setBusy(true); setError("");
    try {
      await addCustomProvider(custom);
      const created = custom.id;
      await reload();
      setSelected(created);
      setAdding("builtin");
      setCustom(emptyCustom);
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("无法添加自定义提供方", "Could not add custom provider")); }
    finally { setBusy(false); }
  };
  const removeCredential = async (providerId: string) => {
    setBusy(true); setError("");
    try { await logoutProvider(providerId); await reload(); setLogoutTarget(null); setEditing(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("移除认证失败", "Could not remove credentials")); }
    finally { setBusy(false); }
  };
  const authorization = flow?.authorization ?? (flow?.event?.type === "auth_url" || flow?.event?.type === "device_code" ? flow.event : undefined);
  const promptForm = flow?.status === "waiting" && flow.prompt && flow.prompt.type !== "select" && <form onSubmit={(event) => { event.preventDefault(); if (draft.trim()) void submit(draft.trim()); }}><label htmlFor="pi-provider-answer">{flow.prompt.message}</label><div><input id="pi-provider-answer" type={flow.prompt.type === "secret" ? "password" : "text"} autoComplete="off" placeholder={flow.prompt.placeholder} value={draft} onChange={(event) => setDraft(event.target.value)} /><button type="submit" disabled={busy || !draft.trim()}>{t("继续", "Continue")}</button></div></form>;

  return <div className="pi-settings-content">
    <h2>{setupMode ? t("先连接一个模型", "Connect a model to begin") : t("模型", "Models")}</h2>
    <p className="pi-settings-intro">{setupMode ? t("当前没有可用模型。选择提供方完成认证，再在会话中选择模型；也可以添加自定义提供方。", "No models are available yet. Sign in to a provider, then choose a model in the conversation. You can also add a custom provider.") : t("已接入的提供方显示在这里。添加新的提供方后，即可在会话中选择其模型。", "Connected providers appear here. Add a provider to use its models in a conversation.")}</p>
    {error && <p className="pi-settings-error" role="alert">{error}</p>}
    {flow && <section className="pi-provider-flow" aria-label={t("模型登录", "Model sign-in")}>
      <div className="pi-provider-flow-head"><strong>{t("模型登录", "Model sign-in")}{flowProviderName ? ` · ${flowProviderName}` : ""}</strong><button type="button" onClick={() => { if (pendingAuthWindow.current?.id === flow.id) { pendingAuthWindow.current.popup?.close(); pendingAuthWindow.current = null; } if (flow.status === "running" || flow.status === "waiting") void cancelLogin(flow.id).finally(() => setFlow(null)); else setFlow(null); }}>{flow.status === "running" || flow.status === "waiting" ? t("取消", "Cancel") : t("关闭", "Close")}</button></div>
      {flow.status === "done" && <div role="status"><p>{t("已连接。现在可以在会话中选择该提供方的模型。", "Connected. You can now select this provider’s models in a conversation.")}</p><button type="button" onClick={onReturnToConversation}>{t("返回会话选择模型", "Return to conversation and choose a model")}</button></div>}
      {flow.status === "error" && <p role="alert">{flow.error}</p>}
      {flow.status === "running" && !authorization && <p role="status">{t("正在等待提供方响应…", "Waiting for the provider…")}</p>}
      {flow.event?.type === "info" && <p>{flow.event.message}{flow.event.links?.map((link) => { const url = safeUrl(link.url); return url && <a key={url} href={url} target="_blank" rel="noopener noreferrer">{link.label ?? t("打开链接", "Open link")}</a>; })}</p>}
      {flow.event?.type === "progress" && authorization?.type !== "auth_url" && <p>{flow.event.message}</p>}
      {authorization?.type === "auth_url" && <p role="status">{t("请在授权页面完成登录；若页面未自动打开，请点击右侧链接。完成后这里会自动更新。", "Complete sign-in on the authorization page. If it did not open, use the link. This page will update automatically.")} {safeUrl(authorization.url) && <a href={safeUrl(authorization.url)!} target="_blank" rel="noopener noreferrer">{t("打开授权页面", "Open authorization page")}</a>}</p>}
      {authorization?.type === "device_code" && <p>{t("在", "On the")} {safeUrl(authorization.verificationUri) && <a href={safeUrl(authorization.verificationUri)!} target="_blank" rel="noopener noreferrer">{t("验证页面", "verification page")}</a>} {t("输入代码", "enter code")} <code>{authorization.userCode}</code></p>}
      {flow.status === "waiting" && flow.prompt?.type === "select" && <div className="pi-provider-options"><p>{flow.prompt.message}</p>{flow.prompt.options.map((option) => <button key={option.id} type="button" disabled={busy} onClick={() => { void submit(option.id); }}>{option.label}{option.description && <small>{option.description}</small>}</button>)}</div>}
      {promptForm && flow.prompt?.type === "manual_code" && authorization?.type === "auth_url" ? <details className="pi-provider-manual-login"><summary>{t("无法自动完成？手动输入授权码", "Can't finish automatically? Enter an authorization code")}</summary>{promptForm}</details> : promptForm}
    </section>}
    <section className="pi-provider-list" aria-label={t("已接入的模型提供方", "Connected model providers")}>
      {configured.map((provider) => <div className="pi-provider-card" key={provider.id}>
        <div className="pi-provider-card-head"><span className="pi-provider-name">{provider.name}<span className="pi-provider-dot" role="img" aria-label={t("已配置认证", "Authentication configured")} /><small>{t("已配置", "Configured")}</small></span><button type="button" disabled={loginBusy} aria-label={`${t("编辑", "Edit")} ${provider.name}`} aria-expanded={editing === provider.id} onClick={() => { setAdding(null); setEditing(editing === provider.id ? null : provider.id); }}>{t("编辑", "Edit")}</button></div>
        {editing === provider.id && <div className="pi-provider-editor">
          {provider.methods.includes("api_key") && <ApiKeyForm key={provider.id} provider={provider} configured busy={Boolean(loginBusy)} getProviderModels={getProviderModels} updateProviderModel={updateProviderModel} onConnect={(key) => begin(provider.id, "api_key", key)} />}
          {provider.methods.includes("oauth") && <div className="pi-provider-methods"><button type="button" disabled={Boolean(loginBusy)} onClick={() => { void begin(provider.id, "oauth"); }}>{t("网页登录", "Browser sign-in")}</button></div>}
          <PiProviderModelsEditor providerId={provider.id} getModels={getProviderModels} updateModel={updateProviderModel} />
          {provider.storedCredential && <div className="pi-provider-credential-action"><button type="button" disabled={loginBusy} onClick={() => setLogoutTarget(provider.id)}>{t("移除认证", "Remove credentials")}</button></div>}
          {!provider.storedCredential && <p className="pi-provider-auth-source">{t("当前认证来自环境变量、模型配置或其他运行时来源，请在对应位置移除。", "Authentication comes from an environment variable, model configuration, or another runtime source. Remove it at its source.")}</p>}
          {logoutTarget === provider.id && <div className="pi-model-confirm" role="group" aria-label={t("确认移除认证", "Confirm credential removal")}><span>{t("移除本机保存的认证后，该模型可能无法继续使用。", "Removing stored credentials may make this provider unavailable.")}</span><button type="button" disabled={busy} onClick={() => { void removeCredential(provider.id); }}>{t("确认移除", "Remove")}</button><button type="button" disabled={busy} onClick={() => setLogoutTarget(null)}>{t("取消", "Cancel")}</button></div>}
        </div>}
      </div>)}
      {loaded && configured.length === 0 && <p className="pi-provider-empty">{t("尚未接入提供方", "No providers connected yet")}</p>}
      {!loaded && <p role="status">{t("正在读取模型提供方…", "Loading model providers…")}</p>}
    </section>
    {adding === "builtin" && <section className="pi-provider-add-card" aria-label={t("添加提供方", "Add provider")}>
      <div className="pi-provider-flow-head"><strong>{t("添加提供方", "Add provider")}</strong><button type="button" onClick={() => setAdding(null)}>{t("关闭", "Close")}</button></div>
      {selectedProvider ? <><label htmlFor="pi-provider-select">{t("提供方", "Provider")}</label><select id="pi-provider-select" value={selectedProvider.id} onChange={(event) => setSelected(event.target.value)}>{addable.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select>
        {selectedProvider.methods.includes("api_key") && <ApiKeyForm key={selectedProvider.id} provider={selectedProvider} configured={false} busy={Boolean(loginBusy)} getProviderModels={getProviderModels} updateProviderModel={updateProviderModel} onConnect={(key) => begin(selectedProvider.id, "api_key", key)} />}
        {selectedProvider.methods.includes("oauth") && <div className="pi-provider-methods"><button type="button" disabled={Boolean(loginBusy)} onClick={() => { void begin(selectedProvider.id, "oauth"); }}>{t("网页登录", "Browser sign-in")}</button></div>}
        <p>{t("认证完成后，可在提供方的“编辑”中调整模型目录。", "After sign-in, open the provider’s Edit panel to adjust its model catalog.")}</p></> : <p>{t("没有可添加的提供方。", "No providers can be added.")}</p>}
    </section>}
    {adding === "custom" && <section className="pi-provider-add-card" aria-label={t("添加自定义提供方", "Add custom provider")}>
      <div className="pi-provider-flow-head"><strong>{t("添加自定义提供方", "Add custom provider")}</strong><button type="button" onClick={() => setAdding(null)}>{t("关闭", "Close")}</button></div>
      <p>{t("适用于兼容 Pi 已支持协议的模型服务。保存后再添加 API Key；密钥不会写入 models.json。", "For model services compatible with Pi’s supported protocols. Add an API key after saving; it will not be written to models.json.")}</p>
      <form className="pi-provider-custom-form" onSubmit={(event) => { event.preventDefault(); void createCustom(); }}>
        <label>{t("名称", "Name")}<input required maxLength={100} value={custom.name} onChange={(event) => setCustom({ ...custom, name: event.target.value })} placeholder={t("我的模型服务", "My model service")} /></label>
        <label>{t("提供方 ID", "Provider ID")}<input required maxLength={64} value={custom.id} onChange={(event) => setCustom({ ...custom, id: event.target.value })} placeholder="my-provider" /></label>
        <label>{t("接口地址", "API URL")}<input required type="url" maxLength={2048} value={custom.baseUrl} onChange={(event) => setCustom({ ...custom, baseUrl: event.target.value })} placeholder="https://api.example.com/v1" /></label>
        <label>{t("接口协议", "API protocol")}<select value={custom.api} onChange={(event) => setCustom({ ...custom, api: event.target.value as CustomProviderInput["api"] })}><option value="openai-completions">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option></select></label>
        <label>{t("模型 ID", "Model ID")}<input required maxLength={200} value={custom.modelId} onChange={(event) => setCustom({ ...custom, modelId: event.target.value })} placeholder="model-name" /></label>
        <button type="submit" disabled={busy}>{t("保存并继续", "Save and continue")}</button>
      </form>
    </section>}
    {!adding && <div className="pi-provider-add-actions"><button type="button" disabled={!loaded || addable.length === 0 || loginBusy} onClick={() => { setEditing(null); setAdding("builtin"); setSelected(""); }}>{t("＋ 添加提供方", "＋ Add provider")}</button><button type="button" disabled={loginBusy} onClick={() => { setEditing(null); setAdding("custom"); }}>{t("＋ 添加自定义提供方", "＋ Add custom provider")}</button></div>}
  </div>;
}
