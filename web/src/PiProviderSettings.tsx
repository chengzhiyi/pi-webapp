import { useEffect, useRef, useState } from "react";
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
  return <div className="pi-provider-methods">{provider.methods.map((method) => <button key={method} type="button" disabled={busy} onClick={() => onLogin(method)}>{method === "oauth" ? "网页登录" : "添加 API Key"}</button>)}</div>;
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
  useEffect(() => { void reload().catch((cause) => { setLoaded(true); setError(cause instanceof Error ? cause.message : "无法读取模型提供方"); }); }, []);
  useEffect(() => {
    if (!flow || flow.status === "done" || flow.status === "error" || flow.status === "cancelled") return;
    let alive = true;
    const timer = window.setInterval(() => {
      void getLogin(flow.id).then(async (next) => {
        if (!alive) return;
        await acceptLoginView(next);
      }).catch((cause) => { if (alive) setError(cause instanceof Error ? cause.message : "登录状态不可用"); });
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
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法开始登录"); }
    finally { setBusy(false); }
  };
  const submit = async (value: string) => {
    if (!flow) return;
    setBusy(true); setError("");
    try { await respondLogin(flow.id, value); setDraft(""); await acceptLoginView(await getLogin(flow.id)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "提交失败"); }
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
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法添加自定义提供方"); }
    finally { setBusy(false); }
  };

  return <div className="pi-settings-content">
    <h2>模型</h2>
    <p className="pi-settings-intro">已接入的提供方显示在这里。添加新的提供方后，即可在会话中选择其模型。</p>
    {error && <p className="pi-settings-error" role="alert">{error}</p>}
    {flow && <section className="pi-provider-flow" aria-label="模型登录">
      <div className="pi-provider-flow-head"><strong>模型登录</strong><button type="button" onClick={() => { if (flow.status === "running" || flow.status === "waiting") void cancelLogin(flow.id).finally(() => setFlow(null)); else setFlow(null); }}>{flow.status === "running" || flow.status === "waiting" ? "取消" : "关闭"}</button></div>
      {flow.status === "done" && <p role="status">已连接。现在可以在会话中选择该提供方的模型。</p>}
      {flow.status === "error" && <p role="alert">{flow.error}</p>}
      {flow.status === "running" && <p role="status">正在等待提供方响应…</p>}
      {flow.event?.type === "info" && <p>{flow.event.message}{flow.event.links?.map((link) => { const url = safeUrl(link.url); return url && <a key={url} href={url} target="_blank" rel="noopener noreferrer">{link.label ?? "打开链接"}</a>; })}</p>}
      {flow.event?.type === "progress" && <p>{flow.event.message}</p>}
      {flow.event?.type === "auth_url" && <p>{flow.event.instructions} {safeUrl(flow.event.url) && <a href={safeUrl(flow.event.url)!} target="_blank" rel="noopener noreferrer">打开授权页面</a>}</p>}
      {flow.event?.type === "device_code" && <p>在 {safeUrl(flow.event.verificationUri) && <a href={safeUrl(flow.event.verificationUri)!} target="_blank" rel="noopener noreferrer">验证页面</a>} 输入代码 <code>{flow.event.userCode}</code></p>}
      {flow.status === "waiting" && flow.prompt?.type === "select" && <div className="pi-provider-options"><p>{flow.prompt.message}</p>{flow.prompt.options.map((option) => <button key={option.id} type="button" disabled={busy} onClick={() => { void submit(option.id); }}>{option.label}{option.description && <small>{option.description}</small>}</button>)}</div>}
      {flow.status === "waiting" && flow.prompt && flow.prompt.type !== "select" && <form onSubmit={(event) => { event.preventDefault(); if (draft.trim()) void submit(draft.trim()); }}><label htmlFor="pi-provider-answer">{flow.prompt.message}</label><div><input id="pi-provider-answer" type={flow.prompt.type === "secret" ? "password" : "text"} autoComplete="off" placeholder={flow.prompt.placeholder} value={draft} onChange={(event) => setDraft(event.target.value)} /><button type="submit" disabled={busy || !draft.trim()}>继续</button></div></form>}
    </section>}
    <section className="pi-provider-list" aria-label="已接入的模型提供方">
      {configured.map((provider) => <div className="pi-provider-card" key={provider.id}>
        <div className="pi-provider-card-head"><span className="pi-provider-name">{provider.name}<span className="pi-provider-dot" role="img" aria-label="已连接" /></span><button type="button" disabled={loginBusy} aria-label={`编辑 ${provider.name}`} onClick={() => { setAdding(null); setEditing(editing === provider.id ? null : provider.id); }}>编辑</button></div>
        {editing === provider.id && <MethodButtons provider={provider} busy={Boolean(loginBusy)} onLogin={(method) => { void begin(provider.id, method); }} />}
      </div>)}
      {loaded && configured.length === 0 && <p className="pi-provider-empty">尚未接入提供方</p>}
      {!loaded && <p role="status">正在读取模型提供方…</p>}
    </section>
    {adding === "builtin" && <section className="pi-provider-add-card" aria-label="添加提供方">
      <div className="pi-provider-flow-head"><strong>添加提供方</strong><button type="button" onClick={() => setAdding(null)}>关闭</button></div>
      {selectedProvider ? <><label htmlFor="pi-provider-select">提供方</label><select id="pi-provider-select" value={selectedProvider.id} onChange={(event) => setSelected(event.target.value)}>{addable.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select><MethodButtons provider={selectedProvider} busy={Boolean(loginBusy)} onLogin={(method) => { void begin(selectedProvider.id, method); }} /></> : <p>没有可通过网页登录添加的提供方。</p>}
    </section>}
    {adding === "custom" && <section className="pi-provider-add-card" aria-label="添加自定义提供方">
      <div className="pi-provider-flow-head"><strong>添加自定义提供方</strong><button type="button" onClick={() => setAdding(null)}>关闭</button></div>
      <p>适用于兼容 Pi 已支持协议的模型服务。保存后再添加 API Key；密钥不会写入 models.json。</p>
      <form className="pi-provider-custom-form" onSubmit={(event) => { event.preventDefault(); void createCustom(); }}>
        <label>名称<input required maxLength={100} value={custom.name} onChange={(event) => setCustom({ ...custom, name: event.target.value })} placeholder="我的模型服务" /></label>
        <label>提供方 ID<input required maxLength={64} value={custom.id} onChange={(event) => setCustom({ ...custom, id: event.target.value })} placeholder="my-provider" /></label>
        <label>接口地址<input required type="url" maxLength={2048} value={custom.baseUrl} onChange={(event) => setCustom({ ...custom, baseUrl: event.target.value })} placeholder="https://api.example.com/v1" /></label>
        <label>接口协议<select value={custom.api} onChange={(event) => setCustom({ ...custom, api: event.target.value as CustomProviderInput["api"] })}><option value="openai-completions">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option></select></label>
        <label>模型 ID<input required maxLength={200} value={custom.modelId} onChange={(event) => setCustom({ ...custom, modelId: event.target.value })} placeholder="model-name" /></label>
        <button type="submit" disabled={busy}>保存并继续</button>
      </form>
    </section>}
    {!adding && <div className="pi-provider-add-actions"><button type="button" disabled={!loaded || addable.length === 0 || loginBusy} onClick={() => { setEditing(null); setAdding("builtin"); setSelected(""); }}>＋ 添加提供方</button><button type="button" disabled={loginBusy} onClick={() => { setEditing(null); setAdding("custom"); }}>＋ 添加自定义提供方</button></div>}
  </div>;
}
