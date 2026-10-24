import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { WorkbenchPanelProps } from "../../../../contracts/workbench.ts";
import { MAX_SCENE_BYTES, validateScene, type DiagramDraft, type DiagramScene } from "../contract/diagrams.ts";
import { diagramAction } from "./api.ts";
import { diagramModel } from "./model.ts";
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

/** The panel is the native editor. File operations live inside its hamburger menu. */
export function DiagramEditor(p: WorkbenchPanelProps) {
  const model = diagramModel(p.session.sessionId, p.contentId);
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot);
  const [canvas, setCanvas] = useState<CanvasModule | null>(null), [error, setError] = useState("");
  const [dialog, setDialog] = useState<"save" | "open" | null>(null), [path, setPath] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const [backups, setBackups] = useState<{ key: string; scene: DiagramScene }[] | null>(null);
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
  const openDialog = (mode: "save" | "open") => { setPath(mode === "save" ? state.draft?.path ?? `diagrams/${p.contentId}.excalidraw` : ""); setDialog(mode); };
  const openBackups = () => {
    try {
      const found: { key: string; scene: DiagramScene }[] = [];
      const prefix = `pi-diagram:${p.session.sessionId}:`;
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)!;
        if (key.startsWith(prefix)) { try { found.push({ key, scene: validateScene(JSON.parse(localStorage.getItem(key)!)) }); } catch { /* Invalid backups are not imported. */ } }
      }
      setBackups(found);
    } catch (e) { setError(errorText(e)); }
  };
  const exportScene = async (transparent: boolean) => {
    await model.flush();
    const scene = model.getSnapshot().scene;
    if (!canvas || !scene) return;
    download(await canvas.png(scene, transparent), `${state.draft?.title ?? "diagram"}.png`);
  };
  const downloadSource = async () => { const scene = model.getSnapshot().scene; if (scene) download(new Blob([JSON.stringify(scene)], { type: "application/json" }), `${state.draft?.title ?? "diagram"}.excalidraw`); };
  return <section className={css.editor} aria-label={t("Excalidraw 编辑器", "Excalidraw editor")} onKeyDownCapture={event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); event.stopPropagation(); openDialog("save"); }
  }}>
    <div className={css.canvas} data-diagram-canvas>{p.visible && canvas && state.scene ? <canvas.default scene={state.scene} readOnly={state.busy} locale={p.locale} onChange={value => model.change(value)} onError={setError}
      saveStatus={state.unsynced ? t("同步中…", "Syncing…") : state.draft?.savedRevision === state.draft?.revision ? t("已保存到工作区", "Saved to workspace") : t("尚未保存到工作区", "Not saved to workspace")} onSave={() => openDialog("save")} onOpen={() => openDialog("open")} onImport={() => file.current?.click()} onRecover={openBackups} onExport={transparent => void run(() => exportScene(transparent))} onDownload={() => void run(downloadSource)}
    /> : <p role="status">{error || "Excalidraw…"}</p>}</div>
    <input ref={file} className={css.hidden} type="file" aria-label={t("导入源文件", "Import source")} accept=".excalidraw,application/json" onChange={event => {
      const source = event.target.files?.[0]; event.target.value = ""; if (!source) return;
      void run(async () => { if (source.size > MAX_SCENE_BYTES) throw new Error("图稿超过 512 KiB");
        const draft = await diagramAction<DiagramDraft>(p.session.sessionId, "import", { scene: JSON.parse(await source.text()), title: source.name.replace(/\.excalidraw$/, "").slice(0, 500) });
        p.open("diagram", draft.id, "Excalidraw");
      });
    }} />
    {dialog && <div className={css.modalBackdrop}><form className={css.dialog} role="dialog" aria-label={dialog === "save" ? t("保存图稿", "Save diagram") : t("打开图稿", "Open diagram")} onSubmit={event => {
      event.preventDefault(); void run(async () => {
        if (dialog === "save") await model.mutate("save", { path });
        else { const draft = await diagramAction<DiagramDraft>(p.session.sessionId, "open", { path }); p.open("diagram", draft.id, "Excalidraw"); }
        setDialog(null);
      });
    }}>
      <label>{t("工作区路径", "Workspace path")}<input autoFocus aria-label={t("工作区路径", "Workspace path")} value={path} onChange={e => setPath(e.target.value)} placeholder="diagrams/example.excalidraw" /></label>
      <div><button type="button" onClick={() => setDialog(null)}>{t("取消", "Cancel")}</button><button disabled={state.busy || !path.trim()}>{dialog === "save" ? t("保存", "Save") : t("打开", "Open")}</button></div>
      {(error || state.error) && <p role="alert">{error || state.error}</p>}
    </form></div>}
    {backups && <div className={css.modalBackdrop}><div className={css.dialog} role="dialog" aria-label={t("恢复本地备份", "Recover local backup")}>
      {backups.length === 0 && <p>{t("没有此会话的本地备份", "No local backups for this session")}</p>}
      {backups.map(backup => <div key={backup.key}><span>{backup.key.split(":").at(-1)?.slice(0, 8)}</span><button onClick={() => void run(async () => {
        const draft = await diagramAction<DiagramDraft>(p.session.sessionId, "import", { scene: backup.scene, title: "Recovered Excalidraw" });
        setBackups(null); p.open("diagram", draft.id, "Excalidraw");
      })}>{t("恢复为新图稿", "Restore as new drawing")}</button><button onClick={() => download(new Blob([JSON.stringify(backup.scene)], { type: "application/json" }), "recovered.excalidraw")}>{t("下载备份", "Download backup")}</button></div>)}
      <div><button onClick={() => setBackups(null)}>{t("关闭", "Close")}</button></div>
    </div></div>}
    {state.recovered && <div className={css.recovery} role="status">{t("发现未保存的本地备份", "Unsaved local backup found")}
      <button onClick={() => model.restore()}>{t("恢复", "Restore")}</button><button onClick={() => model.dismissRecovery()}>{t("保留当前图稿", "Keep current")}</button>
    </div>}
    {!dialog && (error || state.error) && <div className={css.error} role="alert">{error || state.error}<button onClick={() => void run(() => model.reload())}>{t("重新载入", "Reload")}</button><button onClick={() => void run(downloadSource)}>{t("下载草稿", "Download draft")}</button></div>}
  </section>;
}
