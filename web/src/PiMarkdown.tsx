import { useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { localize as t } from "./ui/locale/preference.ts";

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
  return <div className="pi-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
    a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
  }}>{text}</ReactMarkdown></div>;
}
