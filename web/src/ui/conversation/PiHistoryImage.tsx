import { useEffect, useRef, useState } from "react";
import { ImageLightbox } from "./ImageLightbox.tsx";
import css from "./MessageImage.module.css";

// Bound the image long edge without upscaling.
function singleFit(width: number, height: number) {
  const natural = width / height;
  const ratio = Math.min(4, Math.max(0.25, natural));
  const box = ratio >= 1 ? { width: 240, height: 240 / ratio } : { width: 240 * ratio, height: 240 };
  const scale = Math.min(1, width / box.width, height / box.height);
  return {
    width: Math.max(1, Math.round(box.width * scale)),
    height: Math.max(1, Math.round(box.height * scale)),
    objectPosition: natural < 0.25 ? "center top" : natural > 4 ? "left center" : "center",
  };
}

export function PiHistoryImage({ name, messageId, index, file, tile, loadImage }: {
  name: string;
  messageId: string;
  index: number;
  file?: File;
  tile: boolean;
  loadImage: (messageId: string, index: number) => Promise<Blob>;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const loader = useRef(loadImage);
  loader.current = loadImage;

  useEffect(() => {
    let live = true;
    let objectUrl: string | null = null;
    setUrl(null);
    setFailed(false);
    setSize(null);
    if (file) {
      objectUrl = URL.createObjectURL(file);
      setUrl(objectUrl);
    } else {
      void loader.current(messageId, index).then((blob) => {
        const next = URL.createObjectURL(blob);
        if (live) { objectUrl = next; setUrl(next); }
        else URL.revokeObjectURL(next);
      }).catch(() => { if (live) setFailed(true); });
    }
    return () => { live = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [file, messageId, index, attempt]);

  const fit = !tile && size ? singleFit(size.width, size.height) : null;
  if (failed) return <button type="button" className={css.error} data-variant={tile ? "tile" : "single"} onClick={() => setAttempt((value) => value + 1)}>图片加载失败，重试</button>;
  return <>
    <button type="button" className={css.frame} data-variant={tile ? "tile" : "single"} aria-label={`预览 ${name}`} title="查看原图" disabled={!url} onClick={() => setOpen(true)} style={fit ? { width: fit.width, height: fit.height } : undefined}>
      {url ? <img src={url} alt={name} onLoad={(event) => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} onError={() => setFailed(true)} style={fit ? { objectPosition: fit.objectPosition } : undefined} /> : <span className={css.loading}>加载中</span>}
    </button>
    {open && url && <ImageLightbox src={url} alt={name} labels={{ dialog: "图片预览", close: "关闭预览" }} onClose={() => setOpen(false)} />}
  </>;
}
