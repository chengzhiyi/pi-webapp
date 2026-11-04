import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { CodeBlock } from "../../../../../web/src/ui/shared/primitives/markdown/CodeBlock.tsx";
import { IconRefreshOutlineRegular } from "../../../../../web/src/ui/shared/primitives/icons/index.tsx";
import { ImageLightbox } from "../../../../../web/src/ui/conversation/ImageLightbox.tsx";
import { localize as t } from "../../../../../web/src/ui/locale/preference.ts";
import { HttpError } from "../../../../host/client/http-error.ts";
import { workspaceFilesApi } from "./workspace-files-api.ts";
import type { WorkspaceFilePreview as Preview } from "../contract/workspace-files.ts";
import css from "../../../../../web/src/ui/workbench/WorkspacePanel.module.css";

/** Resolve a Markdown image destination against the previewed file's directory; undefined when remote, absolute-scheme or escaping the workspace. */
export function resolveWorkspaceImagePath(markdownPath: string, destination: string): string | undefined {
  let value = destination.replace(/[?#].*$/u, "");
  try { value = decodeURI(value); } catch { /* keep authored text */ }
  if (value === "" || value.includes("\\") || value.includes("\0") || /^[a-z][a-z\d+.-]*:/iu.test(value) || value.startsWith("//")) return undefined;
  const segments = value.startsWith("/") ? [] : markdownPath.split("/").slice(0, -1);
  for (const part of value.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") { if (segments.pop() === undefined) return undefined; } else segments.push(part);
  }
  return segments.length ? segments.join("/") : undefined;
}

/** Textareas report LF; files that used CRLF are written back with CRLF. */
const normalize = (text: string) => text.replace(/\r\n/gu, "\n");

type SaveProblem = { kind: "conflict" } | { kind: "error"; message: string };

/** Conversation streaming must not repeatedly parse an unchanged preview. */
export const WorkspaceFilePreview = memo(function WorkspaceFilePreview({ sessionId, path, renderMarkdown, breadcrumb, trailing, refresh = 0, reveal, onDirtyChange, onSaved }: {
  sessionId: string; path: string; renderMarkdown(text: string, pathImages?: { resolve(value: string): string | undefined }): ReactNode;
  /** Replaces the plain path label; trailing controls follow the reload button. */
  breadcrumb?: ReactNode; trailing?: ReactNode;
  /** A change re-reads the file unless it is being edited (e.g. after the agent finishes a turn). */
  refresh?: number;
  /** Scroll to and mark a 1-based source line; a new object reveals again. */
  reveal?: { line: number };
  onDirtyChange?(dirty: boolean): void;
  onSaved?(): void;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [source, setSource] = useState(false);
  const [lightbox, setLightbox] = useState(false);
  const [imageError, setImageError] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<SaveProblem | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const editing = draft !== null;
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(false); setImageError(false); setLightbox(false);
    void workspaceFilesApi.preview(sessionId, path, controller.signal).then(value => {
      if (!controller.signal.aborted) { setPreview(value); setLoading(false); }
    }).catch(() => {
      if (!controller.signal.aborted) { setError(true); setLoading(false); }
    });
    return () => controller.abort();
  }, [sessionId, path, revision]);
  // Follow outside changes, but never under the user's unsaved edits.
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const firstRefresh = useRef(refresh);
  useEffect(() => {
    if (refresh === firstRefresh.current || editingRef.current) return;
    setRevision(value => value + 1);
  }, [refresh]);
  const markdown = /\.(?:md|markdown|mdown)$/i.test(path);
  const name = path.split("/").at(-1)!;
  const extension = name.includes(".") ? name.split(".").at(-1)!.toLowerCase() : name.toLowerCase();
  const language = ({ mjs: "javascript", cjs: "javascript", mts: "typescript", cts: "typescript", md: "markdown", svg: "xml", gitignore: "text", dockerfile: "dockerfile", makefile: "make" } as Record<string, string>)[extension] ?? extension;
  const [imageTick, setImageTick] = useState(0);
  const images = useRef(new Map<string, string | null>());
  useEffect(() => {
    const cache = images.current;
    cache.clear();
    return () => { for (const url of cache.values()) if (url) URL.revokeObjectURL(url); cache.clear(); };
  }, [sessionId, path, revision]);
  const pathImages = useMemo(() => ({
    resolve(value: string): string | undefined {
      const target = resolveWorkspaceImagePath(path, value);
      if (target === undefined) return undefined;
      const cache = images.current;
      const hit = cache.get(target);
      if (hit !== undefined) return hit ?? undefined;
      cache.set(target, null);
      void workspaceFilesApi.raw(sessionId, target, new AbortController().signal).then(blob => {
        if (images.current !== cache || cache.get(target) !== null) return;
        cache.set(target, URL.createObjectURL(blob));
        setImageTick(value => value + 1);
      }).catch(() => { /* Missing or unsupported images stay as alt text. */ });
      return undefined;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [sessionId, path, revision, imageTick]);
  const text = preview?.kind === "text" ? preview : null;
  const dirty = editing && text !== null && draft !== normalize(text.text);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  // Search hits in Markdown point at source lines.
  useEffect(() => { if (reveal && markdown) setSource(true); }, [reveal, markdown]);
  // Only a highlighted source view has numbered lines to reveal.
  const revealable = !loading && !editing && preview?.kind === "text" && (!markdown || source);
  useEffect(() => {
    const root = body.current;
    if (!reveal || !revealable || !root) return;
    let scrolled = false;
    const mark = () => {
      const line = root.querySelectorAll<HTMLElement>("pre code .line")[reveal.line - 1];
      if (!line) return;
      for (const old of root.querySelectorAll("[data-files-reveal]")) if (old !== line) old.removeAttribute("data-files-reveal");
      line.setAttribute("data-files-reveal", "");
      if (!scrolled) { scrolled = true; line.scrollIntoView({ block: "center" }); }
    };
    mark();
    // Highlighting replaces the plain lines once the grammar loads.
    const observer = new MutationObserver(mark);
    observer.observe(root, { childList: true, subtree: true });
    const stop = window.setTimeout(() => observer.disconnect(), 3000);
    return () => { observer.disconnect(); window.clearTimeout(stop); };
  }, [reveal, revealable]);
  useEffect(() => { if (editing) textarea.current?.focus(); }, [editing]);
  const reload = () => setRevision(value => value + 1);
  const confirmDiscard = () => !dirty || window.confirm(t("放弃未保存的更改？", "Discard unsaved changes?"));
  const startEditing = () => { if (text) { setProblem(null); setDraft(normalize(text.text)); } };
  const stopEditing = () => { if (confirmDiscard()) { setDraft(null); setProblem(null); } };
  const save = async (overwrite = false) => {
    if (!text || draft === null || saving) return;
    setSaving(true); setProblem(null);
    try {
      let version = text.version;
      if (overwrite) {
        const latest = await workspaceFilesApi.preview(sessionId, path, new AbortController().signal);
        if (latest.kind !== "text") throw new Error("not text");
        version = latest.version;
      }
      const output = text.text.includes("\r\n") ? draft.replace(/\n/gu, "\r\n") : draft;
      const saved = await workspaceFilesApi.write(sessionId, path, output, version);
      setPreview({ ...text, text: output, version: saved.version, size: saved.size });
      onSaved?.();
    } catch (cause) {
      if (cause instanceof HttpError && cause.status === 409 && cause.reason === "conflict") setProblem({ kind: "conflict" });
      else if (cause instanceof HttpError && cause.status === 413) setProblem({ kind: "error", message: t("内容过大，无法保存（最多 512 KB、10,000 行）。", "Too large to save (512 KB or 10,000 lines at most).") });
      else if (cause instanceof HttpError && cause.status === 409) setProblem({ kind: "error", message: t("会话已切换，未保存。", "The session changed, so nothing was saved.") });
      else setProblem({ kind: "error", message: t("保存失败，文件可能已移动、删除或无权写入。", "Could not save. The file may have moved, been deleted, or be read-only.") });
    } finally { setSaving(false); }
  };
  const editorKeys = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); return; }
    // Tab indents; Shift+Tab keeps its usual meaning, so focus can always leave the editor.
    if (event.key === "Tab" && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      const indent = /^\t/mu.test(draft ?? "") ? "\t" : "  ";
      // execCommand keeps the native undo stack; setRangeText is the fallback.
      if (!document.execCommand("insertText", false, indent)) {
        const target = event.currentTarget;
        target.setRangeText(indent, target.selectionStart, target.selectionEnd, "end");
        setDraft(target.value);
      }
    }
  };
  const image = useMemo(() => preview?.kind === "image" ? `data:${preview.mimeType};base64,${preview.data}` : null, [preview]);
  const content = () => {
    if (loading && !preview) return <p className={css.state} role="status">{t("正在读取…", "Reading…")}</p>;
    if (error) return <div className={css.state} role="status"><p>{t("文件读取失败，可能已移动、删除或无权访问。", "Could not read this file. It may have moved, been deleted, or be inaccessible.")}</p><button type="button" className={css.textButton} onClick={reload}>{t("重试", "Retry")}</button></div>;
    if (!preview) return null;
    if (preview.kind === "too-large") return <p className={css.state}>{preview.unit === "lines"
      ? t(`文件行数过多，最多预览 ${preview.limit} 行。`, `File has too many lines. Limit: ${preview.limit} lines.`)
      : t(`文件过大，无法预览。大小上限：${preview.limit / 1024} KB`, `File is too large to preview. Limit: ${preview.limit / 1024} KB`)}</p>;
    if (preview.kind === "unsupported") return <p className={css.state}>{t("暂不支持预览此文件类型。", "Preview is unavailable for this file type.")}</p>;
    if (preview.kind === "image" && image) {
      if (imageError) return <p className={css.state}>{t("图片无法解码。", "This image could not be decoded.")}</p>;
      return <button type="button" className={css.imageButton} aria-label={t("放大图片", "Enlarge image")} onClick={() => setLightbox(true)}><img className={css.image} src={image} alt={name} onError={() => setImageError(true)} /></button>;
    }
    if (preview.kind !== "text") return null;
    if (editing) return <textarea className={css.editor} value={draft} aria-label={t(`编辑 ${name}`, `Edit ${name}`)} title={t("Tab 缩进，Shift+Tab 离开编辑器，⌘/Ctrl+S 保存", "Tab indents, Shift+Tab leaves the editor, ⌘/Ctrl+S saves")}
      spellCheck={false} autoCapitalize="off" autoComplete="off" autoCorrect="off" wrap="off" ref={textarea}
      onChange={event => setDraft(event.target.value)} onKeyDown={editorKeys} />;
    if (preview.text === "") return <p className={css.state}>{t("空文件", "Empty file")}</p>;
    if (markdown && !source) return <div className={css.markdown}>{renderMarkdown(preview.text, pathImages)}</div>;
    return <CodeBlock code={preview.text} lang={language} lineNumbers className={css.code} copyLabel={t("复制", "Copy")} copiedLabel={t("已复制", "Copied")} toolbarLabels={{ codeLabel: t("代码", "Code"), wrapLabel: t("自动换行", "Wrap"), unwrapLabel: t("取消换行", "Unwrap") }} />;
  };
  return <div className={css.body}>
    <div className={css.toolbar}>
      {breadcrumb ?? <span className={css.path} title={path}>{path}</span>}
      {dirty && <span className={css.unsaved} role="status">{t("未保存", "Unsaved")}</span>}
      {!text && <span className={css.readonly}>{t("只读", "Read only")}</span>}
      {markdown && text && !editing && <button type="button" className={css.textButton} aria-pressed={source} onClick={() => setSource(value => !value)}>{source ? t("预览", "Preview") : t("源码", "Source")}</button>}
      {text && !editing && <button type="button" className={css.textButton} onClick={startEditing}>{t("编辑", "Edit")}</button>}
      {editing && <>
        <button type="button" className={css.textButton} onClick={stopEditing}>{dirty ? t("取消", "Cancel") : t("完成", "Done")}</button>
        <button type="button" className={`${css.textButton} ${css.primaryButton}`} disabled={!dirty || saving} onClick={() => void save()}>{saving ? t("正在保存…", "Saving…") : t("保存", "Save")}</button>
      </>}
      {!editing && <button type="button" className={css.iconButton} aria-label={t("重新读取文件", "Reload file")} title={t("重新读取文件", "Reload file")} onClick={reload}><IconRefreshOutlineRegular /></button>}
      {trailing}
    </div>
    {problem && <div className={css.saveProblem} role="alert">
      {problem.kind === "conflict" ? <>
        <span>{t("文件在你编辑期间已在磁盘上更改。", "This file changed on disk while you were editing.")}</span>
        <button type="button" className={css.textButton} onClick={() => { setDraft(null); setProblem(null); reload(); }}>{t("放弃我的更改并重新读取", "Discard mine and reload")}</button>
        <button type="button" className={css.textButton} onClick={() => void save(true)}>{t("覆盖", "Overwrite")}</button>
      </> : <span>{problem.message}</span>}
    </div>}
    <div ref={body} className={css.preview} aria-busy={loading}>{content()}</div>
    {lightbox && image && <ImageLightbox src={image} alt={name} labels={{ dialog: t("图片预览", "Image preview"), close: t("关闭图片预览", "Close image preview") }} onClose={() => setLightbox(false)} />}
  </div>;
});
