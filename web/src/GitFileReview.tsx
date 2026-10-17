import { useEffect, useRef, type ReactNode } from "react";
import { localize as t } from "./ui/locale/preference.ts";
import css from "./workspace-git.module.css";

/** Stable list DOM keeps its scroll position while the keyed preview changes. */
export function GitFileReview({ children, preview, selectionKey, onClose }: {
  children: ReactNode; preview: ReactNode; selectionKey: string | null; onClose(): void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const hasPreview = !!preview;
  useEffect(() => {
    if (hasPreview && selectionKey) root.current?.querySelector<HTMLElement>('[data-git-file][aria-pressed="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectionKey, hasPreview]);
  return <div className={css.reviewLayout} data-preview={hasPreview} ref={root}>
    {children}
    {preview && <div className={css.inlinePreview} role="region" aria-label={t("差异预览", "Diff preview")} onKeyDown={event => {
      if (event.key === "Escape" && !event.nativeEvent.isComposing && !event.defaultPrevented) { event.preventDefault(); onClose(); }
    }}>{preview}</div>}
  </div>;
}
