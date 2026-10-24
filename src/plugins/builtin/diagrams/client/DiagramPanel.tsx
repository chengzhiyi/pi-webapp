import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { WorkbenchPanelProps } from "../../../../contracts/workbench.ts";
import { MAX_SCENE_BYTES, type DiagramDraft, type DiagramScene, type DiagramSummary } from "../contract/diagrams.ts";
import { diagramAction, stopDiagramGeneration } from "./api.ts";
import { diagramModel } from "./model.ts";
import css from "./diagrams.module.css";
type CanvasModule = typeof import("./Canvas.tsx");
export function download(blob: Blob, name: string) { const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10000); }
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function DiagramList(p: WorkbenchPanelProps) {
  const [prompt, setPrompt] = useState("");
  const [items, setItems] = useState<DiagramSummary[]>([]), [backups, setBackups] = useState<{ key: string; scene: DiagramScene }[]>([]), [path, setPath] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const t = (zh: string, en: string) => p.locale === "zh" ? zh : en;
  useEffect(() => {
    if (!p.visible) return;
    const abort = new AbortController();
    const refresh = () => { void diagramAction<DiagramSummary[]>(p.session.sessionId, "list", {}, abort.signal).then(setItems).catch(e => { if (!abort.signal.aborted) setError(errorText(e)); }); };
    refresh();
    try {
      const prefix = `pi-diagram:${p.session.sessionId}:`;
      const found: { key: string; scene: DiagramScene }[] = [];
      for (let i = 0; i < localStorage.length; i++) { const key = localStorage.key(i)!; if (key.startsWith(prefix)) { try { found.push({ key, scene: JSON.parse(localStorage.getItem(key)!) }); } catch { /* Invalid backups cannot be imported. */ } } }
      setBackups(found);
    } catch { /* Storage access may be disabled by browser policy. */ }
    const timer = setInterval(refresh, 2000);
    return () => { abort.abort(); clearInterval(timer); };
  }, [p.visible, p.session.sessionId]);
  const open = async (action: string, input = {}) => {
    setBusy(true); setError("");
    try { const draft = await diagramAction<DiagramDraft>(p.session.sessionId, action, input); p.open("diagram", draft.id, draft.title); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  return <section className={css.panel} aria-label={t("手绘图", "Diagrams")}>
    <div className={css.welcome}><span className={css.welcomeIcon} aria-hidden="true">✎</span><h3>{t("把想法画出来", "Turn ideas into diagrams")}</h3>
    <p>{t("描述你想表达的内容，图稿将直接出现在对话中。", "Describe your idea. An editable diagram will appear in the conversation.")}</p></div>
    <div className={css.startComposer}><textarea aria-label={t("新图要求", "New diagram instructions")} placeholder={t("例如：画一张分层架构图，区分入口、核心、运行库与外部服务…", "For example: a layered architecture with entry points, core, libraries and external services…")} value={prompt} onChange={e => setPrompt(e.target.value)} rows={3} />
      <button disabled={!p.session.model || !p.session.idle || !prompt.trim() || busy} onClick={async () => {
        setBusy(true); setError("");
        try { await p.sendMessage(`请先读取 diagram_reference 构图参考，再使用 diagram_create 生成可编辑图稿，使用清晰的分层、标题和适当配色。不要直接写文件，等待用户接受候选。用户要求：\n${prompt}`); setPrompt(""); }
        catch (e) { setError(errorText(e)); } finally { setBusy(false); }
      }}>{t("生成图稿 ↗", "Create diagram ↗")}</button></div>
    <div className={css.suggestions}>{[t("画一张 Pi 分层架构图，包含外部边界和实验路径", "Draw a layered Pi architecture with external boundaries and an experimental path"), t("画一个含失败重试分支的登录流程", "Draw a login flow with a retry branch")].map(example => <button key={example} onClick={() => setPrompt(example)}>{example}</button>)}</div>
    {!p.session.model && <p>{t("选择模型后可 AI 绘图；也可以新建空白图手工绘制。", "Choose a model for AI generation, or start with a blank canvas.")}</p>}
    <div className={css.toolbar}><button disabled={busy} onClick={() => void open("new")}>{t("新建图稿", "New diagram")}</button>
      <label className={css.file}>{t("导入源文件", "Import source")}<input type="file" accept=".excalidraw,application/json" disabled={busy} onChange={async e => {
        const file = e.target.files?.[0]; e.target.value = ""; if (!file) return;
        if (file.size > MAX_SCENE_BYTES) { setError(t("图稿超过 512 KiB", "Diagram exceeds 512 KiB")); return; }
        try { await open("import", { scene: JSON.parse(await file.text()), title: file.name.replace(/\.excalidraw$/, "").slice(0, 500) }); } catch (error) { setError(errorText(error)); }
      }} /></label></div>
    <div className={css.toolbar}><input aria-label={t("工作区图稿路径", "Workspace diagram path")} value={path} onChange={e => setPath(e.target.value)} placeholder="diagrams/example.excalidraw" />
      <button disabled={busy || !path} onClick={() => void open("open", { path })}>{t("打开文件", "Open file")}</button></div>
    {error && <p role="alert">{error}</p>}
    <ul className={css.list}>{items.map(d => <li key={d.id}><button onClick={() => p.open("diagram", d.id, d.title)}>{d.title} · {d.pending ? t("待接受候选", "Candidate pending") : d.revision === d.savedRevision ? t("已保存", "Saved") : t("未保存", "Unsaved")}</button><small>{d.path ?? d.id}</small></li>)}</ul>
    {backups.length > 0 && <details><summary>{t("浏览器未保存备份", "Unsaved browser backups")} ({backups.length})</summary>{backups.map(backup => <div className={css.toolbar} key={backup.key}><button disabled={busy} onClick={() => void open("import", { scene: backup.scene, title: "恢复的图稿" })}>{t("恢复为新图稿", "Restore as new diagram")}</button><button onClick={() => download(new Blob([JSON.stringify(backup.scene)], { type: "application/json" }), "recovered.excalidraw")}>{t("下载备份", "Download backup")}</button><small>{backup.key.split(":").at(-1)}</small></div>)}</details>}
    <p>{t("仅本地文件；不连接 Excalidraw 云协作。不支持图片、外链和嵌入网页。", "Local files only; no Excalidraw cloud collaboration. Images, links and embeds are not supported.")}</p>
  </section>;
}

export function DiagramEditor(p: WorkbenchPanelProps) {
  const model = p.resource(() => diagramModel(p.session.sessionId, p.contentId), value => value.suspend());
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot);
  const [canvas, setCanvas] = useState<CanvasModule | null>(null), [loadError, setLoadError] = useState("");
  const [path, setPath] = useState(""), [prompt, setPrompt] = useState(""), [preview, setPreview] = useState(true), [transparent, setTransparent] = useState(false), [message, setMessage] = useState("");
  const t = (zh: string, en: string) => p.locale === "zh" ? zh : en;
  useEffect(() => {
    if (!p.visible) return;
    let active = true;
    import("./Canvas.tsx").then(module => { if (active) setCanvas(module); }).catch(e => { if (active) setLoadError(errorText(e)); });
    const abort = new AbortController();
    void model.refresh(abort.signal);
    const timer = setInterval(() => { void model.refresh(abort.signal); }, 1500);
    return () => { active = false; abort.abort(); clearInterval(timer); model.suspend(); };
  }, [model, p.visible]);
  useEffect(() => { if (state.draft && !path) setPath(state.draft.path ?? `diagrams/${state.draft.id}.excalidraw`); }, [state.draft, path]);
  useEffect(() => { setPreview(true); }, [state.draft?.candidate?.id]);
  useEffect(() => {
    const dirty = state.unsynced || (!!state.draft && state.draft.revision !== state.draft.savedRevision);
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [state.unsynced, state.draft?.revision, state.draft?.savedRevision]);
  const candidateKey = JSON.stringify(state.draft?.candidate);
  const proposal = useMemo((): { scene: DiagramScene | null; error: string } => {
    if (!canvas || !state.scene || !state.draft?.candidate) return { scene: null, error: "" };
    try { return { scene: canvas.materialize(state.scene, state.draft.candidate), error: "" }; }
    catch (e) { return { scene: null, error: errorText(e) }; }
  }, [canvas, state.scene, candidateKey]);
  const run = async (operation: () => Promise<unknown>) => { setMessage(""); try { await operation(); } catch (e) { setMessage(errorText(e)); } };
  const draft = state.draft;
  const candidate = draft?.candidate;
  const stale = !!candidate && (candidate.baseRevision !== draft?.revision || state.unsynced);
  const display = preview && proposal.scene ? proposal.scene : state.scene;
  const currentScene = () => {
    if (!canvas || !state.scene) throw new Error("画布尚未加载");
    // Revalidate through export/persistence boundaries; never export an unaccepted candidate.
    return state.scene;
  };
  return <section className={css.editor} aria-label={t("图稿编辑器", "Diagram editor")}>
    <div className={css.controls}>
      <div className={css.toolbar}><strong>{draft?.title ?? t("正在加载…", "Loading…")}</strong><span className={css.badge} role="status">{state.unsynced ? t("同步中…", "Syncing…") : draft && draft.revision === draft.savedRevision ? t("已保存", "Saved") : t("草稿", "Draft")}</span></div>
      <div className={css.toolbar}>
        <button className={css.primary} disabled={!draft || state.busy || !!candidate} onClick={() => void run(async () => { await model.mutate("save", { path }); setMessage(t("已保存到工作区", "Saved to workspace")); })}>{t("保存 / 另存", "Save / Save as")}</button>
        <button disabled={!canvas || !draft || state.busy || !!candidate} onClick={() => void run(async () => { const blob = await canvas!.png(currentScene(), transparent); download(blob, `${draft!.title}-r${draft!.revision}.png`); })}>{t("导出 PNG", "Export PNG")}</button>
        <details className={css.more}><summary>{t("文件与更多", "Files & more")}</summary><div className={css.advanced}>
        <label>{t("保存路径", "Save path")}<input aria-label={t("保存路径", "Save path")} value={path} onChange={e => setPath(e.target.value)} /></label>
        <button disabled={!state.scene} onClick={() => state.scene && download(new Blob([JSON.stringify(state.scene)], { type: "application/json" }), `${draft?.title ?? "diagram"}.excalidraw`)}>{t("下载源文件", "Download source")}</button>
        <label><input type="checkbox" checked={transparent} onChange={e => setTransparent(e.target.checked)} />{t("透明底", "Transparent")}</label>
        <button disabled={state.busy} onClick={() => { if (window.confirm(t("重新载入服务端图稿？本地未同步内容请先下载。", "Reload server draft? Download any unsynced local changes first."))) void run(() => model.reload()); }}>{t("重新载入", "Reload draft")}</button>
        <small>{draft ? `r${draft.revision} · ${draft.id}` : ""}</small>
        </div></details>
      </div>
      {state.recovered && <div className={css.notice}>{t("发现与服务端不同的浏览器草稿备份。", "A different browser draft backup was found.")}<button onClick={() => model.restore()}>{t("恢复备份", "Restore backup")}</button><button onClick={() => model.dismissRecovery()}>{t("保留服务端版本", "Keep server version")}</button></div>}
      {candidate && <div className={css.notice}>
        <strong>{t("AI 修改候选 · 尚未应用", "AI candidate · not applied")}</strong>
        {stale && <span>{t("候选已过期，请拒绝后重新生成。", "Candidate is stale. Reject it and regenerate.")}</span>}
        <button onClick={() => setPreview(v => !v)}>{preview ? t("查看原图", "View original") : t("预览候选", "Preview candidate")}</button>
        <button disabled={!proposal.scene || stale || state.busy} onClick={() => void run(() => model.mutate("accept", { scene: proposal.scene }))}>{t("接受候选", "Accept candidate")}</button>
        <button disabled={state.busy} onClick={() => void run(() => model.mutate("reject"))}>{t("拒绝候选", "Reject candidate")}</button>
      </div>}
      {(state.error || loadError || proposal.error || message) && <p role="alert">{[state.error, loadError, proposal.error, message].filter(Boolean).join(" · ")}</p>}
    </div>
    <div className={css.canvas} data-diagram-canvas>{p.visible && canvas && display ? <canvas.default key={preview && candidate ? candidate.id : "current"} scene={display} readOnly={!!(preview && candidate) || state.busy} locale={p.locale} onChange={value => model.change(value)} onError={setMessage} /> : <p>{loadError || t("画布按需加载中…", "Loading canvas on demand…")}</p>}</div>
    <div className={css.editComposer}>
      <div className={css.toolbar}><input aria-label={t("绘图要求", "Diagram instructions")}  placeholder={t("描述新图或要修改的内容", "Describe a diagram or a local edit")} value={prompt} onChange={e => setPrompt(e.target.value)} />
        <button disabled={!p.session.model || !p.session.idle || !prompt.trim() || !!candidate || state.busy || !draft} onClick={() => void run(async () => {
          await model.flush();
          const current = model.getSnapshot().draft!;
          await p.sendMessage(current.scene.elements.length ? `请使用 diagram_read 读取图稿 ${current.id} 的最新同步修订，再用 diagram_patch 提出以下修改；保持其他元素的位置和文案，等待用户接受候选，不要直接写文件。用户要求：\n${prompt}` : `请先读取 diagram_reference，再使用 diagram_create 生成可编辑图稿候选，合理使用分层、注释和配色，不要直接写文件。用户要求：\n${prompt}`);
          setPrompt(""); setMessage(t("已发送到对话；新图将在回答卡片或图稿列表中出现。", "Sent to chat. New diagrams appear in the response card or diagram list."));
        })}>{t("让 Agent 绘图 / 改图", "Ask agent to draw / edit")}</button>
        {!p.session.idle && <button onClick={() => void run(() => stopDiagramGeneration(p.session.sessionId))}>{t("停止当前生成", "Stop generation")}</button>}
        {!p.session.model && <span>{t("未选择模型；仍可手工编辑。", "No model selected; manual editing is available.")}</span>}
      </div>
      <small>{candidate ? t("当前为只读候选预览；接受后可编辑、保存和导出。", "Read-only candidate preview. Accept to edit, save and export.") : t("继续描述修改要求，或直接在画布上编辑。", "Describe your next edit, or edit directly on the canvas.")}</small>
    </div>
  </section>;
}
