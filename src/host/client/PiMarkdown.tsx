import { memo, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { localize as t, useLocale } from "../../../web/src/ui/locale/preference.ts";
import { useMarkdownDelegate } from "../../../web/src/ui/shared/primitives/markdown/MarkdownDelegate.tsx";
import { parseFileLink } from "../../../web/src/ui/shared/primitives/markdown/file-link.ts";
import { writeClipboard } from "../../../web/src/ui/shared/primitives/clipboard.ts";

function CodeBlock({ children }: { children?: ReactNode }) {
  const code = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  return <div className="pi-code-block">
    <div className="pi-code-toolbar"><button type="button" onClick={async () => {
      const ok = await writeClipboard(code.current?.textContent ?? "");
      setCopied(ok);
      if (ok) window.setTimeout(() => setCopied(false), 1800);
    }}>{copied ? t("已复制", "Copied") : t("复制代码", "Copy code")}</button></div>
    <pre ref={code}>{children}</pre>
  </div>;
}

const remarkPlugins = [remarkGfm];

/** Parsing is the costly part of a chat render: settled blocks keep their text while a
 * reply streams, so they skip it. The locale subscription keeps the code toolbar current. */
export const PiMarkdown = memo(function PiMarkdown({ text }: { text: string }) {
  useLocale();
  const { openFile } = useMarkdownDelegate();
  const components = useMemo<Components>(() => ({
    pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
    a: ({ href, children }) => {
      const file = href ? parseFileLink(href) : undefined;
      const local = file !== undefined && openFile !== undefined;
      return <a href={href} target={local || href?.startsWith("#") ? undefined : "_blank"} rel="noopener noreferrer" onClick={local ? event => {
        event.preventDefault();
        openFile(file.path, file.line === undefined ? undefined : { line: file.line });
      } : undefined}>{children}</a>;
    },
  }), [openFile]);
  return <div className="pi-markdown"><ReactMarkdown remarkPlugins={remarkPlugins} components={components}>{text}</ReactMarkdown></div>;
});
