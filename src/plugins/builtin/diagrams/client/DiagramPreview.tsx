import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ToolViewProps } from "../../../../contracts/workbench.ts";
import type { SessionView } from "../../../../contracts/bridge-contract.ts";
import { emptyScene, partialDrawing, record, validateDrawing } from "../contract/diagrams.ts";
import { diagramModel } from "./model.ts";
import css from "./diagrams.module.css";

/** A native tool-result view: arguments arrive before the tool finishes, results identify the editable model. */
export function DiagramToolView(p: ToolViewProps) {
  const session = p.session as SessionView | null;
  let result: Record<string, unknown> | null = null;
  try { const parsed: unknown = JSON.parse(p.result?.blocks.filter(b => b.kind === "text").map(b => b.text).join("") ?? "null"); if (record(parsed)) result = parsed; } catch { /* Non-JSON errors remain readable below. */ }
  if (p.result?.isError) return <div className={css.error} role="alert">{p.result.blocks.map(b => b.text).join("\n")}</div>;
  if (session && result && typeof result.id === "string" && /^[\w-]{1,80}$/.test(result.id)) return <DiagramPreview sessionId={session.sessionId} id={result.id} title={typeof result.title === "string" ? result.title : "Excalidraw"} locale={p.locale} open={() => p.openPanel(`diagram:${result!.id}`)} />;
  return <StreamingDrawing input={p.call.text} locale={p.locale} running={p.running} />;
}

function StreamingDrawing({ input, locale, running }: { input: string; locale: "zh" | "en"; running: boolean }) {
  const latest = useRef(input); latest.current = input;
  const [image, setImage] = useState("");
  useEffect(() => {
    let active = true, busy = false, prior = "", objectUrl = "";
    const render = async () => {
      if (busy || !active || latest.current === prior) return;
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
        const blob = await canvas.thumbnail(scene);
        if (active) { if (objectUrl) URL.revokeObjectURL(objectUrl); objectUrl = URL.createObjectURL(blob); setImage(objectUrl); }
      } catch { /* Incomplete arguments are expected. The final server validation is authoritative. */ }
      finally { busy = false; }
    };
    void render(); const timer = setInterval(() => void render(), 120);
    return () => { active = false; clearInterval(timer); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, []);
  return <article className={css.artifact} aria-label={locale === "zh" ? "正在绘制 Excalidraw" : "Drawing Excalidraw"}>
    <header className={css.toolHeader}><span>{running ? "◌" : "!"}</span> create view{!running && <span>{locale === "zh" ? "未完成，尚未创建图稿" : "Incomplete — no drawing committed"}</span>}</header>
    {image ? <img className={css.streamImage} src={image} alt="Excalidraw" data-stream-preview /> : <div className={css.previewPlaceholder} role="status">{locale === "zh" ? "正在绘图…" : "Drawing…"}</div>}
  </article>;
}

/** Conversation preview and panel share one revisioned native scene. Only the panel mounts an editor. */
export function DiagramPreview({ sessionId, id, title, locale, open }: { sessionId: string; id: string; title: string; locale: "zh" | "en"; open(): void }) {
  const ref = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  const [image, setImage] = useState(""), [error, setError] = useState(""), [renderedKey, setRenderedKey] = useState("");
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(!!entry?.isIntersecting), { rootMargin: "160px" });
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  const model = diagramModel(sessionId, id);
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot);
  const t = (zh: string, en: string) => locale === "zh" ? zh : en;
  useEffect(() => {
    if (!visible) return;
    const abort = new AbortController();
    const refresh = async () => {
      await model.refresh(abort.signal);
      if (abort.signal.aborted) return;
      const canvas = await import("./Canvas.tsx");
      if (!abort.signal.aborted) await model.initialize(canvas.materialize);
    };
    void refresh().catch(e => setError(String(e)));
    const timer = setInterval(() => { if (!document.hidden) void refresh().catch(e => setError(String(e))); }, 1200);
    return () => { abort.abort(); clearInterval(timer); };
  }, [model, visible]);
  const candidateKey = JSON.stringify(state.draft?.candidate);
  const renderKey = `${state.draft?.revision ?? 0}:${state.draft?.candidate?.id ?? "current"}`;
  const candidate = state.draft?.candidate;
  const initial = !!candidate && state.draft?.revision === 0 && !state.draft.scene.elements.length && !candidate.patch;
  const stale = !!candidate && (candidate.baseRevision !== state.draft?.revision || state.unsynced);
  useEffect(() => {
    if (!visible || !state.scene) return;
    let active = true, objectUrl = "";
    const render = async () => {
      try {
        const canvas = await import("./Canvas.tsx");
        const scene = candidate && !stale ? canvas.materialize(state.scene!, candidate) : state.scene!;
        const blob = await canvas.thumbnail(scene);
        if (active) { objectUrl = URL.createObjectURL(blob); setImage(objectUrl); setRenderedKey(renderKey); setError(""); }
      } catch (e) { if (active) setError(e instanceof Error ? e.message : String(e)); }
    };
    void render();
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [visible, state.scene, candidateKey, state.draft?.revision, stale]);
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
    <header className={css.toolHeader}><span>✓</span> create view</header>
    <div className={css.previewViewport} data-diagram-preview>
      {image ? <img src={image} alt={title} data-scene-revision={renderedKey} /> : <div className={css.previewPlaceholder}>{error || state.error || "Excalidraw…"}</div>}
      <button className={css.editButton} onClick={open} aria-label={t("编辑 Excalidraw", "Edit Excalidraw")}>{t("编辑 ↗", "Edit ↗")}</button>
    </div>
    {candidate && !initial && <div className={css.review} role="status"><span>{stale ? t("修改已过期，原图已保留", "Edits are stale; original preserved") : t("AI 修改预览", "AI edit preview")}</span>
      <button disabled={stale || state.busy} onClick={() => void accept()}>{t("应用修改", "Apply edits")}</button><button disabled={state.busy} onClick={() => void model.mutate("reject").catch(e => setError(String(e)))}>{t("保留原图", "Keep original")}</button>
    </div>}
    {(error || state.error) && <p className={css.inlineError} role="alert">{error || state.error}</p>}
  </article>;
}
