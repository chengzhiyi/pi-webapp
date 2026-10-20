import { useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { localize as t } from "../../../web/src/ui/locale/preference.ts";
import { useMarkdownDelegate } from "../../../web/src/ui/shared/primitives/markdown/MarkdownDelegate.tsx";
import { parseFileLink } from "../../../web/src/ui/shared/primitives/markdown/file-link.ts";

function CodeBlock({ children }: { children?: ReactNode }) {
  const code = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  return <div className="pi-code-block">
    <div className="pi-code-toolbar"><button type="button" onClick={async () => {
      try {
        await navigator.clipboard.writeText(code.current?.textContent ?? "");
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1800);
      } catch { setCopied(false); }
    }}>{copied ? t("已复制", "Copied") : t("复制代码", "Copy code")}</button></div>
    <pre ref={code}>{children}</pre>
  </div>;
}

export function PiMarkdown({ text }: { text: string }) {
  const { openFile } = useMarkdownDelegate();
  return <div className="pi-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
    a: ({ href, children }) => {
      const file = href ? parseFileLink(href) : undefined;
      const local = file !== undefined && openFile !== undefined;
      return <a href={href} target={local || href?.startsWith("#") ? undefined : "_blank"} rel="noopener noreferrer" onClick={local ? event => {
        event.preventDefault();
        openFile(file.path, file.line === undefined ? undefined : { line: file.line });
      } : undefined}>{children}</a>;
    },
  }}>{text}</ReactMarkdown></div>;
}
