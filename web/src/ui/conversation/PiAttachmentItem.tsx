import { useCallback, useEffect, useState } from "react";
import { IconCloseFill14 } from "../primitives/icons/index.tsx";
import { ImageLightbox } from "./ImageLightbox.tsx";
import { PiAttachmentCard } from "./PiAttachmentCard.tsx";
import css from "./ComposerAttachments.module.css";
import { localize as t } from "../locale/preference.ts";

export function PiAttachmentItem({ file, status, error, onRemove, onRetry }: {
  file: File;
  status: "uploading" | "ready" | "error";
  error?: string;
  onRemove: () => void;
  onRetry: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const closePreview = useCallback(() => setPreview(false), []);
  const image = /^(image\/(png|jpeg|webp|gif))$/.test(file.type) || /\.(png|jpe?g|webp|gif)$/i.test(file.name);
  useEffect(() => {
    if (!image) return;
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file, image]);

  if (!image) return <PiAttachmentCard name={file.name} bytes={file.size} status={status} error={error} onRemove={onRemove} onRetry={onRetry} />;
  return <div className={css.imageItem} title={file.name}>
    <button type="button" className={css.thumbnail} aria-label={t(`预览 ${file.name}`, `Preview ${file.name}`)} disabled={url === null} onClick={() => setPreview(true)}>
      {url && <img src={url} alt={file.name} />}
    </button>
    <button type="button" className={css.remove} aria-label={t(`移除 ${file.name}`, `Remove ${file.name}`)} onClick={onRemove}><IconCloseFill14 size={12} /></button>
    {status === "uploading" && <span className="pi-image-uploading" role="status">{t("上传中", "Uploading")}</span>}
    {status === "error" && <button type="button" className={css.retryImage} aria-label={t(`重试上传 ${file.name}`, `Retry upload ${file.name}`)} title={error || t("上传失败", "Upload failed")} onClick={onRetry}>{t("重试", "Retry")}</button>}
    {preview && url && <ImageLightbox src={url} alt={file.name} labels={{ dialog: t("图片预览", "Image preview"), close: t("关闭预览", "Close preview") }} onClose={closePreview} />}
  </div>;
}
