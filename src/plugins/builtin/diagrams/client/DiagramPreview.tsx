import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { ToolViewProps } from "../../../../contracts/workbench.ts";
import type { SessionView } from "../../../../contracts/bridge-contract.ts";
import { emptyScene, partialDrawing, record, validateDrawing } from "../contract/diagrams.ts";
import { diagramModel } from "./model.ts";
import css from "./diagrams.module.css";
import { useDiagramTheme } from "./theme.ts";
import { Modal } from "../../../../../web/src/ui/primitives/Modal.tsx";
import { ExcalidrawIcon } from "../../../../../web/src/ui/primitives/ExcalidrawIcon.tsx";

/** Keep the previous thumbnail alive until React commits its replacement, not just
 * until the next render starts (initial materialization and theme changes can race). */
function useThumbnailUrl() {
  const [url, setUrl] = useState("");
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  return [url, setUrl] as const;
}

/** A native tool-result view: arguments arrive before the tool finishes, results identify the editable model. */
export function DiagramToolView(p: ToolViewProps) {
  const session = p.session as SessionView | null;
  const [collapsed, setCollapsed] = useState(false), [details, setDetails] = useState(false);
  const bodyId = useId();
  const parametersButton = useRef<HTMLButtonElement>(null), restoreParametersFocus = useRef(false);
  const closeDetails = () => { restoreParametersFocus.current = true; setDetails(false); };
  useEffect(() => {
    // Completion replaces the preview subtree (and its trigger), but not this owner.
    if (!details && restoreParametersFocus.current) { parametersButton.current?.focus(); restoreParametersFocus.current = false; }
  }, [details]);
  const t = (zh: string, en: string) => p.locale === "zh" ? zh : en;
  const output = p.result?.blocks.filter(b => b.kind === "text").map(b => b.text).join("\n");
  const header = (unavailable = false) => <>
    <header className={css.toolHeader}>
      <button type="button" className={css.previewToggle} aria-expanded={!collapsed} aria-controls={bodyId} aria-label={t("展开或收起图稿", "Toggle drawing preview")} onClick={() => setCollapsed(value => !value)}>
        <ExcalidrawIcon size={18} /><span className={css.toolTitle}>create view</span>
        <span className={css.toolStatus}>{unavailable ? t("原图暂不可用", "Original unavailable") : p.result?.isError ? t("失败", "Failed") : p.result ? t("已完成", "Completed") : p.running ? t("绘制中", "Drawing") : t("未完成", "Incomplete")}</span>
        <svg className={css.previewChevron} data-collapsed={collapsed} width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      <button ref={parametersButton} type="button" className={css.parametersButton} aria-haspopup="dialog" onClick={() => setDetails(true)}>{t("查看参数", "View parameters")}</button>
    </header>
  </>;
  const disclosure = { header, collapsed, bodyId };
  let result: Record<string, unknown> | null = null;
  try { const parsed: unknown = JSON.parse(p.result?.blocks.filter(b => b.kind === "text").map(b => b.text).join("") ?? "null"); if (record(parsed)) result = parsed; } catch { /* Non-JSON errors remain readable below. */ }
  let content: ReactNode;
  if (p.result?.isError) content = <article className={css.artifact}>{header()}<div id={bodyId} hidden={collapsed} className={css.toolError} role="alert">{output}</div></article>;
  else if (session && result && typeof result.id === "string" && /^[\w-]{1,80}$/.test(result.id)) content = <DiagramPreview {...disclosure} sessionId={session.sessionId} id={result.id} title={typeof result.title === "string" ? result.title : "Excalidraw"} locale={p.locale} open={() => p.openPanel(`diagram:${result!.id}`)} />;
  else content = <StreamingDrawing {...disclosure} input={p.call.text} locale={p.locale} running={p.running} />;
  return <>{content}<Modal open={details} onClose={closeDetails} title={t("绘图工具参数", "Drawing tool parameters")} closeLabel={t("关闭", "Close")} className={css.parametersDialog} contentClassName={css.parametersContent}>
    <div className={css.toolDetails}><h3>{t("输入参数", "Input")}</h3><pre tabIndex={0}>{p.call.text}</pre>{output !== undefined && <><h3>{t("工具结果", "Result")}</h3><pre tabIndex={0}>{output}</pre></>}</div>
  </Modal></>;
}

interface Disclosure { header(unavailable?: boolean): ReactNode; collapsed: boolean; bodyId: string }
function StreamingDrawing({ input, locale, running, header, collapsed, bodyId }: Disclosure & { input: string; locale: "zh" | "en"; running: boolean }) {
  const theme = useDiagramTheme();
  const latest = useRef(input); latest.current = input;
  const [image, setImage] = useThumbnailUrl();
  useEffect(() => {
    let active = true, busy = false, prior = "";
    const render = async () => {
      if (collapsed || busy || !active || latest.current === prior) return;
      prior = latest.current; busy = true;
      try {
        const args: unknown = JSON.parse(prior);
        if (!record(args) || typeof args.elements !== "string") return;
        const items = partialDrawing(args.elements).filter(record);
        // Partial streams may reference a shape not emitted yet. Only the temporary preview omits that binding.
        const ids = new Set(items.map(e => e.id));
        const elements = validateDrawing(items.map(e => Object.fromEntries(Object.entries(e).filter(([k, v]) => !["start", "end"].includes(k) || !record(v) || ids.has(v.id)))));
        const canvas = await import("./Canvas.tsx");
        const scene = canvas.materialize(emptyScene(), { id: "stream", baseRevision: 0, elements });
        const blob = await canvas.thumbnail(scene, theme === "dark");
        if (active) setImage(URL.createObjectURL(blob));
      } catch { /* Incomplete arguments are expected. The final server validation is authoritative. */ }
      finally { busy = false; }
    };
    void render(); const timer = setInterval(() => void render(), 120);
    return () => { active = false; clearInterval(timer); };
  }, [theme, collapsed]);
  return <article className={css.artifact} aria-label={locale === "zh" ? "正在绘制 Excalidraw" : "Drawing Excalidraw"}>
    {header()}
    <div id={bodyId} hidden={collapsed}>{image ? <img className={css.streamImage} src={image} alt="Excalidraw" data-stream-preview /> : running && <div className={css.previewPlaceholder} role="status">{locale === "zh" ? "正在绘图…" : "Drawing…"}</div>}
      {!running && <div className={css.previewPlaceholder} role="status">{locale === "zh" ? "未完成，尚未创建图稿" : "Incomplete — no drawing committed"}</div>}
    </div>
  </article>;
}

/** Conversation preview and panel share one revisioned native scene. Only the panel mounts an editor. */
export function DiagramPreview({ sessionId, id, title, locale, open, header, collapsed, bodyId }: Disclosure & { sessionId: string; id: string; title: string; locale: "zh" | "en"; open(): void }) {
  const theme = useDiagramTheme();
  const ref = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  const [image, setImage] = useThumbnailUrl();
  const [error, setError] = useState(""), [renderedKey, setRenderedKey] = useState("");
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(!!entry?.isIntersecting), { rootMargin: "160px" });
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  const model = diagramModel(sessionId, id);
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot);
  const t = (zh: string, en: string) => locale === "zh" ? zh : en;
  useEffect(() => {
    if (!visible || state.unavailable) return;
    const abort = new AbortController();
    const refresh = async () => {
      await model.refresh(abort.signal);
      if (abort.signal.aborted || model.getSnapshot().unavailable) return;
      const canvas = await import("./Canvas.tsx");
      if (!abort.signal.aborted) await model.initialize(canvas.materialize);
    };
    void refresh().catch(e => setError(String(e)));
    const timer = setInterval(() => { if (!document.hidden) void refresh().catch(e => setError(String(e))); }, 1200);
    return () => { abort.abort(); clearInterval(timer); };
  }, [model, visible, state.unavailable]);
  const candidateKey = JSON.stringify(state.draft?.candidate);
  const renderKey = `${state.draft?.revision ?? 0}:${state.draft?.candidate?.id ?? "current"}`;
  const candidate = state.draft?.candidate;
  const initial = !!candidate && state.draft?.revision === 0 && !state.draft.scene.elements.length && !candidate.patch;
  const stale = !!candidate && (candidate.baseRevision !== state.draft?.revision || state.unsynced);
  useEffect(() => {
    if (!visible || !state.scene) return;
    let active = true;
    const render = async () => {
      try {
        const canvas = await import("./Canvas.tsx");
        const scene = candidate && !stale ? canvas.materialize(state.scene!, candidate) : state.scene!;
        const blob = await canvas.thumbnail(scene, theme === "dark");
        if (active) { setImage(URL.createObjectURL(blob)); setRenderedKey(renderKey); setError(""); }
      } catch (e) { if (active) setError(e instanceof Error ? e.message : String(e)); }
    };
    void render();
    return () => { active = false; };
  }, [visible, state.scene, candidateKey, state.draft?.revision, stale, theme]);
  const accept = async () => {
    try {
      await model.flush();
      const current = model.getSnapshot();
      if (!current.draft?.candidate || current.draft.candidate.baseRevision !== current.draft.revision) throw new Error(t("修改已过期，请重新生成", "Edits are stale. Regenerate from the current drawing."));
      const canvas = await import("./Canvas.tsx");
      await model.mutate("accept", { scene: canvas.materialize(current.scene!, current.draft.candidate) });
    } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  };
  return <article ref={ref} className={css.artifact} aria-label={t(`手绘图：${title}`, `Diagram: ${title}`)}>
    {header(state.unavailable)}
    <div id={bodyId} hidden={collapsed}>
    <div className={css.previewViewport} data-diagram-preview>
      {image && !state.unavailable ? <img src={image} alt={title} data-scene-revision={renderedKey} /> : <div className={css.previewPlaceholder}>{state.unavailable ? t("此历史图稿没有可用内容。", "No content is available for this historical drawing.") : error || state.error || "Excalidraw…"}</div>}
      {!state.unavailable && <button className={css.editButton} onClick={open} aria-label={t("编辑 Excalidraw", "Edit Excalidraw")}>{t("编辑 ↗", "Edit ↗")}</button>}
    </div>
    {candidate && !initial && !state.unavailable && <div className={css.review} role="status"><span>{stale ? t("修改已过期，原图已保留", "Edits are stale; original preserved") : t("AI 修改预览", "AI edit preview")}</span>
      <button disabled={stale || state.busy} onClick={() => void accept()}>{t("应用修改", "Apply edits")}</button><button disabled={state.busy} onClick={() => void model.mutate("reject").catch(e => setError(String(e)))}>{t("保留原图", "Keep original")}</button>
    </div>}
    {!state.unavailable && (error || state.error) && <p className={css.inlineError} role="alert">{error || state.error}</p>}
    </div>
  </article>;
}
