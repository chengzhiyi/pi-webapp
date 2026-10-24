import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { diagramModel } from "./model.ts";
import css from "./diagrams.module.css";

/** The conversation mounts an inert image, not another editable canvas. Both views observe the same model. */
export function DiagramPreview({ sessionId, id, title, locale, open }: { sessionId: string; id: string; title: string; locale: "zh" | "en"; open(): void }) {
  const ref = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false), [image, setImage] = useState(""), [error, setError] = useState(""), [zoom, setZoom] = useState(1), [renderedKey, setRenderedKey] = useState("");
  const model = diagramModel(sessionId, id);
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot);
  const t = (zh: string, en: string) => locale === "zh" ? zh : en;
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(!!entry?.isIntersecting), { rootMargin: "160px" });
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    const abort = new AbortController();
    const refresh = () => { if (!document.hidden) void model.refresh(abort.signal); };
    refresh(); const timer = setInterval(refresh, 1800);
    return () => { abort.abort(); clearInterval(timer); };
  }, [model, visible]);
  const candidateKey = JSON.stringify(state.draft?.candidate);
  const renderKey = `${state.draft?.revision ?? 0}:${state.draft?.candidate?.id ?? "current"}`;
  useEffect(() => {
    if (!visible || !state.scene) return;
    let active = true, objectUrl = "";
    const render = async () => {
      try {
        const canvas = await import("./Canvas.tsx");
        const candidate = state.draft?.candidate;
        const scene = candidate && candidate.baseRevision === state.draft?.revision && !state.unsynced ? canvas.materialize(state.scene!, candidate) : state.scene!;
        const blob = await canvas.thumbnail(scene);
        if (active) { objectUrl = URL.createObjectURL(blob); setImage(objectUrl); setRenderedKey(renderKey); setError(""); }
      } catch (e) { if (active) setError(e instanceof Error ? e.message : String(e)); }
    };
    const timer = setTimeout(() => void render(), 200);
    return () => { active = false; clearTimeout(timer); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [visible, state.scene, candidateKey, state.draft?.revision, state.unsynced]);
  const pending = !!state.draft?.candidate;
  const stale = pending && (state.draft?.candidate?.baseRevision !== state.draft?.revision || state.unsynced);
  return <article ref={ref} className={css.artifact} aria-label={t(`手绘图：${title}`, `Diagram: ${title}`)}>
    <header className={css.artifactHeader}><span className={css.artifactIcon} aria-hidden="true">✎</span><strong>{title}</strong><span className={css.badge}>{stale ? t("候选已过期", "Stale candidate") : pending ? t("候选预览", "Candidate preview") : t("可编辑图稿", "Editable diagram")}</span>
      <button onClick={open} aria-label={t("打开编辑", "Open editor")}>{t("编辑 ↗", "Edit ↗")}</button></header>
    <div className={css.previewViewport} data-diagram-preview>
      {image ? <img src={image} alt={title} data-scene-revision={renderedKey} style={{ width: `${zoom * 100}%`, maxWidth: "none" }} /> : <div className={css.previewPlaceholder}>{error || state.error || t("正在准备图稿预览…", "Preparing diagram preview…")}</div>}
    </div>
    <footer className={css.previewFooter}><span>{image && renderedKey !== renderKey ? t("正在更新预览…", "Updating preview…") : stale ? t("候选已过期，显示当前图稿；请重新生成", "Stale candidate; showing current scene. Regenerate in the editor.") : pending ? t("查看后接受候选，原图不会被覆盖", "Review and accept in the editor; the original is unchanged") : t("与编辑器同步 · 保存后可恢复", "Synced with editor · save for durable recovery")}</span><div>
      <button aria-label={t("缩小预览", "Zoom out preview")} disabled={zoom <= 1} onClick={() => setZoom(v => Math.max(1, v - .25))}>−</button>
      <button aria-label={t("适应预览", "Fit preview")} onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
      <button aria-label={t("放大预览", "Zoom in preview")} disabled={zoom >= 3} onClick={() => setZoom(v => Math.min(3, v + .25))}>+</button>
    </div></footer>
    {(error || state.error) && image && <p role="alert">{error || state.error}</p>}
  </article>;
}
