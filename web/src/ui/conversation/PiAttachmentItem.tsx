import { useCallback, useEffect, useState } from "react";
import { IconCloseFill14 } from "../primitives/icons/index.tsx";
import { ImageLightbox } from "./ImageLightbox.tsx";
import { PiAttachmentCard } from "./PiAttachmentCard.tsx";
import css from "./ComposerAttachments.module.css";

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
    <button type="button" className={css.thumbnail} aria-label={`预览 ${file.name}`} disabled={url === null} onClick={() => setPreview(true)}>
      {url && <img src={url} alt={file.name} />}
    </button>
    <button type="button" className={css.remove} aria-label={`移除 ${file.name}`} onClick={onRemove}><IconCloseFill14 size={12} /></button>
    {status === "uploading" && <span className="pi-image-uploading" role="status">上传中</span>}
    {status === "error" && <button type="button" className={css.retryImage} aria-label={`重试上传 ${file.name}`} title={error || "上传失败"} onClick={onRetry}>重试</button>}
    {preview && url && <ImageLightbox src={url} alt={file.name} labels={{ dialog: "图片预览", close: "关闭预览" }} onClose={closePreview} />}
  </div>;
}
