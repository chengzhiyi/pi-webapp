import { useEffect, useRef, useState } from "react";
import { localize as t } from "./ui/locale/preference.ts";
import type { CustomProviderInput, LoginMethod, LoginView, ProviderView } from "./pi-bridge.ts";

interface Props {
  getProviders: () => Promise<ProviderView[]>;
  addCustomProvider: (provider: CustomProviderInput) => Promise<void>;
  startLogin: (providerId: string, method: LoginMethod) => Promise<{ id: string }>;
  getLogin: (id: string) => Promise<LoginView>;
  respondLogin: (id: string, value: string) => Promise<void>;
  cancelLogin: (id: string) => Promise<void>;
  refreshModels: () => Promise<void>;
}

const emptyCustom: CustomProviderInput = { id: "", name: "", baseUrl: "", api: "openai-completions", modelId: "" };

function safeUrl(value: string): string | null {
  try { const url = new URL(value); return url.protocol === "https:" || url.protocol === "http:" ? url.href : null; }
  catch { return null; }
}

function MethodButtons({ provider, busy, onLogin }: { provider: ProviderView; busy: boolean; onLogin: (method: LoginMethod) => void }) {
  return <div className="pi-provider-methods">{provider.methods.map((method) => <button key={method} type="button" disabled={busy} onClick={() => onLogin(method)}>{method === "oauth" ? t("网页登录", "Browser sign-in") : t("添加 API Key", "Add API key")}</button>)}</div>;
}

export function PiProviderSettings({ getProviders, addCustomProvider, startLogin, getLogin, respondLogin, cancelLogin, refreshModels }: Props) {
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [adding, setAdding] = useState<"builtin" | "custom" | null>(null);
  const [selected, setSelected] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [custom, setCustom] = useState<CustomProviderInput>(emptyCustom);
  const [flow, setFlow] = useState<LoginView | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const activeFlow = useRef<LoginView | null>(null);
  activeFlow.current = flow;

  useEffect(() => () => {
    const current = activeFlow.current;
    if (current?.status === "running" || current?.status === "waiting") void cancelLogin(current.id);
  }, []);

  const reload = async () => { setProviders(await getProviders()); setLoaded(true); };
  const acceptLoginView = async (next: LoginView) => {
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
  const configured = providers.filter((provider) => provider.configured);
  const addable = providers.filter((provider) => !provider.configured && provider.methods.length > 0);
  const selectedProvider = addable.find((provider) => provider.id === selected) ?? addable[0];

  const begin = async (providerId: string, method: LoginMethod) => {
    setBusy(true); setError(""); setFlow(null); setDraft("");
    try { const { id } = await startLogin(providerId, method); await acceptLoginView(await getLogin(id)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("无法开始登录", "Could not start sign-in")); }
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

  return <div className="pi-settings-content">
    <h2>{t("模型", "Models")}</h2>
    <p className="pi-settings-intro">{t("已接入的提供方显示在这里。添加新的提供方后，即可在会话中选择其模型。", "Connected providers appear here. Add a provider to use its models in a conversation.")}</p>
    {error && <p className="pi-settings-error" role="alert">{error}</p>}
    {flow && <section className="pi-provider-flow" aria-label={t("模型登录", "Model sign-in")}>
      <div className="pi-provider-flow-head"><strong>{t("模型登录", "Model sign-in")}</strong><button type="button" onClick={() => { if (flow.status === "running" || flow.status === "waiting") void cancelLogin(flow.id).finally(() => setFlow(null)); else setFlow(null); }}>{flow.status === "running" || flow.status === "waiting" ? t("取消", "Cancel") : t("关闭", "Close")}</button></div>
      {flow.status === "done" && <p role="status">{t("已连接。现在可以在会话中选择该提供方的模型。", "Connected. You can now select this provider’s models in a conversation.")}</p>}
      {flow.status === "error" && <p role="alert">{flow.error}</p>}
      {flow.status === "running" && <p role="status">{t("正在等待提供方响应…", "Waiting for the provider…")}</p>}
      {flow.event?.type === "info" && <p>{flow.event.message}{flow.event.links?.map((link) => { const url = safeUrl(link.url); return url && <a key={url} href={url} target="_blank" rel="noopener noreferrer">{link.label ?? t("打开链接", "Open link")}</a>; })}</p>}
      {flow.event?.type === "progress" && <p>{flow.event.message}</p>}
      {flow.event?.type === "auth_url" && <p>{flow.event.instructions} {safeUrl(flow.event.url) && <a href={safeUrl(flow.event.url)!} target="_blank" rel="noopener noreferrer">{t("打开授权页面", "Open authorization page")}</a>}</p>}
      {flow.event?.type === "device_code" && <p>{t("在", "On the")} {safeUrl(flow.event.verificationUri) && <a href={safeUrl(flow.event.verificationUri)!} target="_blank" rel="noopener noreferrer">{t("验证页面", "verification page")}</a>} {t("输入代码", "enter code")} <code>{flow.event.userCode}</code></p>}
      {flow.status === "waiting" && flow.prompt?.type === "select" && <div className="pi-provider-options"><p>{flow.prompt.message}</p>{flow.prompt.options.map((option) => <button key={option.id} type="button" disabled={busy} onClick={() => { void submit(option.id); }}>{option.label}{option.description && <small>{option.description}</small>}</button>)}</div>}
      {flow.status === "waiting" && flow.prompt && flow.prompt.type !== "select" && <form onSubmit={(event) => { event.preventDefault(); if (draft.trim()) void submit(draft.trim()); }}><label htmlFor="pi-provider-answer">{flow.prompt.message}</label><div><input id="pi-provider-answer" type={flow.prompt.type === "secret" ? "password" : "text"} autoComplete="off" placeholder={flow.prompt.placeholder} value={draft} onChange={(event) => setDraft(event.target.value)} /><button type="submit" disabled={busy || !draft.trim()}>{t("继续", "Continue")}</button></div></form>}
    </section>}
    <section className="pi-provider-list" aria-label={t("已接入的模型提供方", "Connected model providers")}>
      {configured.map((provider) => <div className="pi-provider-card" key={provider.id}>
        <div className="pi-provider-card-head"><span className="pi-provider-name">{provider.name}<span className="pi-provider-dot" role="img" aria-label={t("已连接", "Connected")} /></span><button type="button" disabled={loginBusy} aria-label={`${t("编辑", "Edit")} ${provider.name}`} onClick={() => { setAdding(null); setEditing(editing === provider.id ? null : provider.id); }}>{t("编辑", "Edit")}</button></div>
        {editing === provider.id && <MethodButtons provider={provider} busy={Boolean(loginBusy)} onLogin={(method) => { void begin(provider.id, method); }} />}
      </div>)}
      {loaded && configured.length === 0 && <p className="pi-provider-empty">{t("尚未接入提供方", "No providers connected yet")}</p>}
      {!loaded && <p role="status">{t("正在读取模型提供方…", "Loading model providers…")}</p>}
    </section>
    {adding === "builtin" && <section className="pi-provider-add-card" aria-label={t("添加提供方", "Add provider")}>
      <div className="pi-provider-flow-head"><strong>{t("添加提供方", "Add provider")}</strong><button type="button" onClick={() => setAdding(null)}>{t("关闭", "Close")}</button></div>
      {selectedProvider ? <><label htmlFor="pi-provider-select">{t("提供方", "Provider")}</label><select id="pi-provider-select" value={selectedProvider.id} onChange={(event) => setSelected(event.target.value)}>{addable.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select><MethodButtons provider={selectedProvider} busy={Boolean(loginBusy)} onLogin={(method) => { void begin(selectedProvider.id, method); }} /></> : <p>{t("没有可通过网页登录添加的提供方。", "No providers support browser sign-in.")}</p>}
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
