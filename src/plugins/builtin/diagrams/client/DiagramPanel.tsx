import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { WorkbenchPanelProps } from "../../../../contracts/workbench.ts";
import type { DiagramDraft } from "../contract/diagrams.ts";
import { diagramAction } from "./api.ts";
import { diagramModel, type DiagramModel } from "./model.ts";
import css from "./diagrams.module.css";
type CanvasModule = typeof import("./Canvas.tsx");
export function download(blob: Blob, name: string) { const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10000); }
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/** The optional workspace entry opens a blank native canvas, never a second AI composer. */
export function DiagramWorkspace(p: WorkbenchPanelProps) {
  const pending = useRef<Promise<DiagramDraft> | null>(null);
  const [draft, setDraft] = useState<DiagramDraft | null>(null), [error, setError] = useState("");
  useEffect(() => {
    if (!p.visible) return;
    pending.current ??= diagramAction<DiagramDraft>(p.session.sessionId, "new", {});
    void pending.current.then(setDraft).catch(e => setError(errorText(e)));
  }, [p.visible, p.session.sessionId]);
  return draft ? <DiagramEditor {...p} contentId={draft.id} /> : <div role="status">{error || "Excalidraw…"}</div>;
}

/** Key the route so an async fallback can never leak into another session or drawing. */
export function DiagramEditor(p: WorkbenchPanelProps) {
  return <DiagramEditorRoute key={JSON.stringify([p.session.sessionId, p.contentId])} {...p} />;
}
function DiagramEditorRoute(p: WorkbenchPanelProps) {
  const [replacement, setReplacement] = useState<string | null>(null), [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const model = diagramModel(p.session.sessionId, replacement ?? p.contentId);
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot);
  const pending = useRef<{ model: DiagramModel; work: Promise<DiagramDraft> } | null>(null);
  useEffect(() => {
    if (!state.unavailable || !p.visible) return;
    let active = true;
    // One request per missing model, including StrictMode effect replay and polling refreshes.
    if (pending.current?.model !== model) pending.current = { model, work: diagramAction<DiagramDraft>(p.session.sessionId, "new", {}) };
    void pending.current.work.then(draft => { if (active) { setError(""); setReplacement(draft.id); } }).catch(e => { if (active) setError(errorText(e)); });
    return () => { active = false; };
  }, [model, state.unavailable, p.visible, p.session.sessionId, attempt]);
  if (state.unavailable) return <div role="status">{error || (p.locale === "zh" ? "正在打开空白 Excalidraw…" : "Opening a blank Excalidraw…")}
    {error && <button onClick={() => { pending.current = null; setError(""); setAttempt(value => value + 1); }}>{p.locale === "zh" ? "重试" : "Retry"}</button>}
  </div>;
  return <NativeDiagramEditor {...p} key={model.id} contentId={model.id} />;
}

/** Native file operations live in the official menu; the existing workspace-save shortcut remains separate. */
function NativeDiagramEditor(p: WorkbenchPanelProps) {
  const model = diagramModel(p.session.sessionId, p.contentId);
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot);
  const [canvas, setCanvas] = useState<CanvasModule | null>(null), [error, setError] = useState("");
  const [dialog, setDialog] = useState<"save" | null>(null), [path, setPath] = useState("");
  const t = (zh: string, en: string) => p.locale === "zh" ? zh : en;
  const run = async (operation: () => Promise<unknown>) => { setError(""); try { await operation(); } catch (e) { setError(errorText(e)); } };
  useEffect(() => {
    if (!p.visible) return;
    let active = true;
    import("./Canvas.tsx").then(module => { if (active) setCanvas(module); }).catch(e => { if (active) setError(errorText(e)); });
    const abort = new AbortController();
    const refresh = async () => { await model.refresh(abort.signal); };
    void refresh();
    void diagramAction(p.session.sessionId, "focus", { id: p.contentId }).catch(e => { if (active) setError(errorText(e)); });
    const timer = setInterval(() => void refresh(), 1200);
    return () => { active = false; abort.abort(); clearInterval(timer); model.suspend(); };
  }, [model, p.visible, p.contentId, p.session.sessionId]);
  const candidateId = state.draft?.candidate?.id;
  useEffect(() => {
    if (canvas && candidateId) void model.initialize(canvas.materialize).catch(e => setError(errorText(e)));
  }, [canvas, candidateId, model]);
  useEffect(() => {
    const dirty = state.unsynced || (!!state.draft && state.draft.revision !== state.draft.savedRevision);
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [state.unsynced, state.draft?.revision, state.draft?.savedRevision]);
  const openDialog = (_mode: "save") => { setPath(state.draft?.path ?? `diagrams/${p.contentId}.excalidraw`); setDialog("save"); };
  const downloadSource = async () => { const scene = model.getSnapshot().scene; if (scene) download(new Blob([JSON.stringify(scene)], { type: "application/json" }), `${state.draft?.title ?? "diagram"}.excalidraw`); };
  return <section className={css.editor} aria-label={t("Excalidraw 编辑器", "Excalidraw editor")} onKeyDownCapture={event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); event.stopPropagation(); openDialog("save"); }
  }}>
    <div className={css.canvas} data-diagram-canvas>{p.visible && canvas && state.scene ? <canvas.default scene={state.scene} readOnly={state.busy} locale={p.locale} onChange={value => model.change(value)} onError={setError} /> : <p role="status">{error || "Excalidraw…"}</p>}</div>
    {dialog && <div className={css.modalBackdrop}><form className={css.dialog} role="dialog" aria-label={t("保存图稿", "Save diagram")} onSubmit={event => {
      event.preventDefault(); void run(async () => {
        await model.mutate("save", { path });
        setDialog(null);
      });
    }}>
      <label>{t("工作区路径", "Workspace path")}<input autoFocus aria-label={t("工作区路径", "Workspace path")} value={path} onChange={e => setPath(e.target.value)} placeholder="diagrams/example.excalidraw" /></label>
      <div><button type="button" onClick={() => setDialog(null)}>{t("取消", "Cancel")}</button><button disabled={state.busy || !path.trim()}>{t("保存", "Save")}</button></div>
      {(error || state.error) && <p role="alert">{error || state.error}</p>}
    </form></div>}
    {state.recovered && <div className={css.recovery} role="status">{t("发现未保存的本地备份", "Unsaved local backup found")}
      <button onClick={() => model.restore()}>{t("恢复", "Restore")}</button><button onClick={() => model.dismissRecovery()}>{t("保留当前图稿", "Keep current")}</button>
    </div>}
    {!dialog && (error || state.error) && <div className={css.error} role="alert">{error || state.error}<button onClick={() => void run(() => model.reload())}>{t("重新载入", "Reload")}</button><button onClick={() => void run(downloadSource)}>{t("下载草稿", "Download draft")}</button></div>}
  </section>;
}
