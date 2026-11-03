import { lazy, Suspense, useMemo } from "react";
import type { MarkdownLabels, MarkdownPathImages } from "../../../web/src/ui/shared/primitives/markdown/MarkdownText.tsx";
import { localize as t, useLocale } from "../../../web/src/ui/locale/preference.ts";

// KaTeX, Shiki and the shared renderer load after startup instead of in the boot chunk.
// PiApp preloads them once mounted, so the plain-text fallback is rarely seen.
export const loadMarkdownText = () => import("../../../web/src/ui/shared/primitives/markdown/MarkdownText.tsx");
const MarkdownText = lazy(() => loadMarkdownText().then((module) => ({ default: module.MarkdownText })));

/** Localized code and footnote chrome. Identity changes only with the locale, because a new
 * labels object discards MarkdownText's streaming cache mid-message. */
export function useMarkdownLabels(): MarkdownLabels {
  const locale = useLocale();
  return useMemo(() => ({
    code: { copyLabel: t("复制", "Copy"), copiedLabel: t("已复制", "Copied"), toolbarLabels: { codeLabel: t("代码块", "Code block"), wrapLabel: t("自动换行", "Wrap"), unwrapLabel: t("取消换行", "Unwrap") } },
    footnotes: t("脚注", "Footnotes"),
  }), [locale]);
}

export function LazyMarkdownText({ text, streaming, labels, pathImages }: { text: string; streaming?: boolean; labels: MarkdownLabels; pathImages?: MarkdownPathImages }) {
  return <Suspense fallback={<div className="pi-markdown-pending">{text}</div>}>
    <MarkdownText text={text} streaming={streaming} labels={labels} pathImages={pathImages} />
  </Suspense>;
}
