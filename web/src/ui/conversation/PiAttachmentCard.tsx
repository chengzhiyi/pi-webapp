import { FileTypeIcon, fileExtension } from "../primitives/FileTypeIcon.tsx";
import { IconCloseFill14 } from "../primitives/icons/index.tsx";
import { fileSizeText } from "./file-size.ts";
import css from "./FileCard.module.css";

export function PiAttachmentCard({ name, bytes, status, error, onRemove, onRetry }: {
  name: string;
  bytes: number;
  status: "uploading" | "ready" | "error";
  error?: string;
  onRemove: () => void;
  onRetry: () => void;
}) {
  const extension = fileExtension(name).toUpperCase().slice(0, 8);
  const meta = status === "uploading" ? "上传中…" : status === "error" ? (error || "上传失败") : `${extension} ${fileSizeText(bytes)}`;
  return <div className={`${css.card} ${status === "error" ? css.failed : ""}`} title={name}>
    <span className={css.icon} aria-hidden="true">{status === "uploading" ? <span className={css.spinner} /> : <FileTypeIcon path={name} size={28} />}</span>
    {status === "error" ? <button type="button" className={`${css.body} ${css.retry}`} onClick={onRetry} aria-label={`重试上传 ${name}`}>
      <span className={css.name}>{name}</span><span className={`${css.meta} ${css.metaFailed}`}>{meta}</span>
    </button> : <span className={css.body} aria-label={`待发送文件 ${name}`}><span className={css.name}>{name}</span><span className={css.meta}>{meta}</span></span>}
    <button type="button" className={`${css.remove} ${status === "error" ? css.removeFailed : ""}`} aria-label={`移除 ${name}`} onClick={onRemove}><IconCloseFill14 size={12} /></button>
    {status === "uploading" && <span className={css.progressTrack} aria-hidden="true"><span className={css.progressBar} /></span>}
  </div>;
}
