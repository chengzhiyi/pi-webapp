import { memo } from "react";
import { LazyMarkdownText, useMarkdownLabels } from "./markdown-text.tsx";

/** Chat markdown through the shared renderer used by file previews: GFM, KaTeX math and
 * Shiki-highlighted fences. While a reply streams, settled blocks are cached and only the
 * tail re-parses; memoizing on the text lets finished messages skip rendering entirely. */
export const PiMarkdown = memo(function PiMarkdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const labels = useMarkdownLabels();
  return <div className="pi-markdown"><LazyMarkdownText text={text} streaming={streaming} labels={labels} /></div>;
});
