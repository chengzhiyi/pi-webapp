import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CodeBlock } from "../../../../../web/src/ui/shared/primitives/markdown/CodeBlock.tsx";
import { IconRefreshOutlineRegular } from "../../../../../web/src/ui/shared/primitives/icons/index.tsx";
import { ImageLightbox } from "../../../../../web/src/ui/conversation/ImageLightbox.tsx";
import { localize as t } from "../../../../../web/src/ui/locale/preference.ts";
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

/** Conversation streaming must not repeatedly parse an unchanged preview. */
export const WorkspaceFilePreview = memo(function WorkspaceFilePreview({ sessionId, path, renderMarkdown }: {
  sessionId: string; path: string; renderMarkdown(text: string, pathImages?: { resolve(value: string): string | undefined }): ReactNode;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [source, setSource] = useState(false);
  const [lightbox, setLightbox] = useState(false);
  const [imageError, setImageError] = useState(false);
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
  const reload = () => setRevision(value => value + 1);
  const image = useMemo(() => preview?.kind === "image" ? `data:${preview.mimeType};base64,${preview.data}` : null, [preview]);
  const content = () => {
    if (loading) return <p className={css.state} role="status">{t("正在读取…", "Reading…")}</p>;
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
    if (preview.text === "") return <p className={css.state}>{t("空文件", "Empty file")}</p>;
    if (markdown && !source) return <div className={css.markdown}>{renderMarkdown(preview.text, pathImages)}</div>;
    return <CodeBlock code={preview.text} lang={language} lineNumbers className={css.code} copyLabel={t("复制", "Copy")} copiedLabel={t("已复制", "Copied")} toolbarLabels={{ codeLabel: t("代码", "Code"), wrapLabel: t("自动换行", "Wrap"), unwrapLabel: t("取消换行", "Unwrap") }} />;
  };
  return <div className={css.body}>
    <div className={css.toolbar}>
      <span className={css.path} title={path}>{path}</span>
      <span className={css.readonly}>{t("只读", "Read only")}</span>
      {markdown && preview?.kind === "text" && <button type="button" className={css.textButton} aria-pressed={source} onClick={() => setSource(value => !value)}>{source ? t("预览", "Preview") : t("源码", "Source")}</button>}
      <button type="button" className={css.iconButton} aria-label={t("重新读取文件", "Reload file")} title={t("重新读取文件", "Reload file")} onClick={reload}><IconRefreshOutlineRegular /></button>
    </div>
    <div className={css.preview} aria-busy={loading}>{content()}</div>
    {lightbox && image && <ImageLightbox src={image} alt={name} labels={{ dialog: t("图片预览", "Image preview"), close: t("关闭图片预览", "Close image preview") }} onClose={() => setLightbox(false)} />}
  </div>;
});
