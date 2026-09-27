import { useEffect, useState } from "react";
import { formatCapacity, parseCapacity } from "../../shared/model-capacity.ts";
import { localize as t } from "./ui/locale/preference.ts";
import type { ProviderModelChange, ProviderModelFields, ProviderModelRow, ProviderModelsView } from "./pi-bridge.ts";

interface Props {
  providerId: string;
  getModels: (providerId: string) => Promise<ProviderModelsView>;
  updateModel: (providerId: string, change: ProviderModelChange) => Promise<void>;
}

function ModelEditorRow({ model, position, onSave, onRemove, onCancel }: {
  model: ProviderModelRow;
  position: number;
  onSave: (model: ProviderModelFields) => Promise<void>;
  onRemove: () => Promise<void>;
  onCancel?: () => void;
}) {
  const [id, setId] = useState(model.id);
  const [name, setName] = useState(model.name ?? "");
  const [contextWindow, setContextWindow] = useState(formatCapacity(model.contextWindow));
  const [maxTokens, setMaxTokens] = useState(formatCapacity(model.maxTokens));
  const [input, setInput] = useState<Array<"text" | "image">>(model.input?.length ? model.input : ["text"]);
  const [expanded, setExpanded] = useState(!model.id);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const newModel = !model.id;
  const removable = !newModel && (model.source === "custom" || model.overridden);

  const save = async () => {
    const context = parseCapacity(contextWindow);
    const maximum = parseCapacity(maxTokens);
    if (!id.trim() || [context, maximum].some((value) => value !== undefined && (!Number.isSafeInteger(value) || value <= 0))) {
      setError(t("请填写模型 ID，并使用正整数或 K/M 单位填写容量。", "Enter a model ID and positive token counts, optionally with K/M suffixes."));
      return;
    }
    setBusy(true); setError("");
    try {
      await onSave({ id: id.trim(), ...(name.trim() ? { name: name.trim() } : {}), ...(context === undefined ? {} : { contextWindow: context }), ...(maximum === undefined ? {} : { maxTokens: maximum }), input });
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("保存失败", "Could not save")); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true); setError("");
    try { await onRemove(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("操作失败", "Action failed")); setConfirmRemove(false); }
    finally { setBusy(false); }
  };
  const toggleInput = (value: "text" | "image") => {
    setInput((current) => {
      const next = current.includes(value) ? current.filter((item) => item !== value) : [...current, value];
      return next.length ? next : current;
    });
  };

  return <div className="pi-model-entry">
    <div className="pi-model-row">
      <input aria-label={`${t("模型 ID", "Model ID")} ${position}`} placeholder={t("模型 ID", "Model ID")} value={id} disabled={busy || (!newModel && model.source === "builtin")} onFocus={() => setExpanded(true)} onChange={(event) => setId(event.target.value)} />
      <input aria-label={`${t("显示名称", "Display name")} ${position}`} placeholder={t("显示名称", "Display name")} value={name} disabled={busy} onFocus={() => setExpanded(true)} onChange={(event) => setName(event.target.value)} />
      <button type="button" aria-label={`${t("模型参数", "Model settings")} ${position}`} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "⌄" : "›"}</button>
    </div>
    {expanded && <div className="pi-model-details">
      <label>{t("上下文窗口", "Context window")}<input aria-label={`${t("上下文窗口", "Context window")} ${position}`} inputMode="decimal" placeholder="128K" value={contextWindow} disabled={busy} onChange={(event) => setContextWindow(event.target.value)} /></label>
      <label>{t("最大输出 token 数", "Max output tokens")}<input aria-label={`${t("最大输出 token 数", "Max output tokens")} ${position}`} inputMode="decimal" placeholder="16K" value={maxTokens} disabled={busy} onChange={(event) => setMaxTokens(event.target.value)} /></label>
      <fieldset className="pi-model-input-types"><legend>{t("输入类型", "Input types")}</legend>
        <label><input type="checkbox" checked={input.includes("text")} disabled={busy || input.length === 1 && input.includes("text")} onChange={() => toggleInput("text")} />{t("文本", "Text")}</label>
        <label><input type="checkbox" checked={input.includes("image")} disabled={busy || input.length === 1 && input.includes("image")} onChange={() => toggleInput("image")} />{t("图片", "Image")}</label>
      </fieldset>
      <div className="pi-model-actions"><button type="button" disabled={busy} onClick={() => { void save(); }}>{busy ? t("保存中…", "Saving…") : t("保存模型", "Save model")}</button>
        {newModel && onCancel && <button type="button" disabled={busy} onClick={onCancel}>{t("取消", "Cancel")}</button>}
        {removable && <button type="button" disabled={busy} onClick={() => setConfirmRemove(!confirmRemove)}>{model.source === "custom" ? t("移除模型", "Remove model") : t("恢复默认", "Restore default")}</button>}
      </div>
      {confirmRemove && <div className="pi-model-confirm"><span>{model.source === "custom" ? t("从配置中移除这个模型？", "Remove this model from configuration?") : t("撤销这个模型的自定义参数？", "Discard this model’s custom settings?")}</span><button type="button" disabled={busy} onClick={() => { void remove(); }}>{t("确认", "Confirm")}</button><button type="button" disabled={busy} onClick={() => setConfirmRemove(false)}>{t("取消", "Cancel")}</button></div>}
      {error && <p className="pi-settings-error" role="alert">{error}</p>}
    </div>}
  </div>;
}

export function PiProviderModelsEditor({ providerId, getModels, updateModel }: Props) {
  const [view, setView] = useState<ProviderModelsView | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const reload = async () => {
    setError("");
    try { setView(await getModels(providerId)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("无法读取模型目录", "Could not load model catalog")); throw cause; }
  };
  useEffect(() => { void reload().catch(() => {}); }, [providerId]);
  const change = async (value: ProviderModelChange) => {
    await updateModel(providerId, value);
    setAdding(false);
    await reload().catch(() => {});
  };
  const models = view?.models.filter((model) => `${model.id} ${model.name ?? ""}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())) ?? [];
  return <section className="pi-provider-models" aria-label={t("模型目录", "Model catalog")}>
    <div className="pi-provider-models-head"><strong>{t("模型目录", "Model catalog")}</strong><span>{view?.models.length ?? 0} {t("个模型", "models")}</span></div>
    {view?.baseUrl && <p className="pi-provider-models-endpoint" title={view.baseUrl}>{t("API 地址", "API URL")}: {view.baseUrl}</p>}
    {error && <p className="pi-settings-error" role="alert">{error} {view && <button type="button" onClick={() => { void reload().catch(() => {}); }}>{t("重试读取", "Retry")}</button>}</p>}
    {!view ? error
      ? <button type="button" className="pi-model-add" onClick={() => { void reload().catch(() => {}); }}>{t("重试读取", "Retry")}</button>
      : <p role="status">{t("正在读取模型…", "Loading models…")}</p> : <>
      {view.models.length > 5 && <input className="pi-model-search" type="search" aria-label={t("搜索模型", "Search models")} placeholder={t("搜索模型", "Search models")} value={query} onChange={(event) => setQuery(event.target.value)} />}
      <div className="pi-model-list">{models.map((model, index) => <ModelEditorRow key={`${model.id}:${model.name}:${model.contextWindow}:${model.maxTokens}:${model.overridden}`} model={model} position={index + 1} onSave={(fields) => change({ action: "save", originalId: model.id, model: fields })} onRemove={() => change({ action: "remove", id: model.id })} />)}</div>
      {models.length === 0 && !adding && <p className="pi-provider-models-empty">{t("没有匹配的模型", "No matching models")}</p>}
      {adding && <ModelEditorRow key="new" model={{ id: "", source: "custom", overridden: false }} position={view.models.length + 1} onSave={(fields) => change({ action: "save", model: fields })} onRemove={async () => setAdding(false)} onCancel={() => setAdding(false)} />}
      {!adding && <button type="button" className="pi-model-add" onClick={() => setAdding(true)}>{t("＋ 添加模型", "＋ Add model")}</button>}
    </>}
  </section>;
}
