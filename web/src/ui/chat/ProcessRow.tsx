import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ViewBlock, ViewMessage, ViewUsage } from "../../pi-bridge.ts";
import { DisclosureRow } from "../primitives/DisclosureRow.tsx";
import { TerminalBlock } from "../primitives/TerminalBlock.tsx";
import { IconChevronDownOutline14, IconCodeOutline16, IconCopyOutline16, IconDatabaseOutline16 } from "../primitives/icons/index.tsx";
import toolCss from "./ToolRow.module.css";
import processCss from "./TurnProcess.module.css";
import usageCss from "./TurnUsagePanel.module.css";
import dialogCss from "./stat-dialog.module.css";
import actionsCss from "./MessageIconActions.module.css";

function toolSummary(block: ViewBlock): string {
  try {
    const args = JSON.parse(block.text) as Record<string, unknown>;
    const value = args.command ?? args.file_path ?? args.path ?? args.url ?? args.query ?? args.pattern;
    if (typeof value === "string") return value;
  } catch { /* Raw input remains available in the expanded card. */ }
  return block.text;
}

/** Pi tool data displayed in a tool row and IN/OUT card. */
export function ToolRow({ block, result, running, onInspect, cwd }: {
  block: ViewBlock; result?: ViewMessage; running?: boolean; onInspect?: () => void; cwd?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const output = result?.blocks.map((part) => part.text).join("\n") ?? null;
  const state = result?.isError ? "error" : result ? "ok" : running ? "running" : "pending";
  const shell = block.toolName === "bash" || block.toolName === "pwsh";
  const title = ({ bash: "Bash", pwsh: "PowerShell", read: "读取", write: "写入", edit: "编辑", grep: "搜索", glob: "搜索" } as Record<string, string>)[block.toolName || ""] || block.toolName || "工具调用";
  const command = toolSummary(block);
  return <div className={toolCss.root} data-state={state} data-tool={block.toolName}>
    <DisclosureRow icon={<IconCodeOutline16 size={14} />} title={title} open={expanded} onToggle={() => setExpanded((value) => !value)}
      rowClassName={toolCss.row} leadingClassName={toolCss.leading} titleClassName={toolCss.title} chevronClassName={toolCss.chevron}
      collapsedContent={<><span className={toolCss.sep} aria-hidden /><span className={`${toolCss.summary} ${state === "error" ? toolCss.errorSummary : ""}`}>{state === "error" ? output?.split("\n", 1)[0] : command}</span></>}>
      <div className={toolCss.bodyWrap}>
        {shell ? <TerminalBlock command={command} cwd={cwd} output={output ?? undefined} running={output === null} exitCode={result?.isError ? 1 : result ? 0 : undefined} maxLines={Infinity} className={toolCss.terminalBody} labels={{
          signal: (signal) => `信号 ${signal}`, exitCode: (code) => `退出码 ${code}`, running: "运行中", failed: "失败", done: "已完成", copy: "复制", copied: "已复制", noOutput: "无输出", collapseAria: "收起输出", collapse: "收起", expandAria: (hidden) => `展开其余 ${hidden} 行输出`, expand: (hidden) => `… 其余 ${hidden} 行`,
        }} /> : <div className={toolCss.ioCard}>
          <div className={toolCss.ioSection}><span className={toolCss.ioLabel}>IN</span><span className={toolCss.ioText}>{block.text}</span></div>
          {output !== null && <><span className={toolCss.ioDivider} aria-hidden /><div className={toolCss.ioSection}><span className={toolCss.ioLabel}>OUT</span><span className={toolCss.ioText} data-error={result?.isError || undefined}>{output || "无文本输出"}</span></div></>}
        </div>}
        {onInspect && <button className={toolCss.inspectButton} type="button" onClick={onInspect}>查看轨迹</button>}
      </div>
    </DisclosureRow>
  </div>;
}

/** Turn-level process disclosure. */
export function TurnProcess({ toolCount, messageCount, open, onToggle }: {
  toolCount: number; messageCount: number; open: boolean; onToggle: () => void;
}) {
  const labels = [toolCount > 0 && `${toolCount} 次工具调用`, messageCount > 0 && `${messageCount} 条消息`].filter(Boolean);
  return <button type="button" className={processCss.root} data-open={open || undefined} aria-expanded={open} onClick={onToggle}>
    <span className={processCss.label}>{labels.length ? labels.join(" · ") : "已思考"}</span>
    <IconChevronDownOutline14 className={processCss.chevron} />
  </button>;
}

function formatTokens(value: number): string { return `${value.toLocaleString()} tok`; }

/** Usage pill and stat dialog in the reply action row. */
export function UsagePill({ usage, model }: { usage: ViewUsage; model: string | null }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = root.current?.getBoundingClientRect();
      const box = panel.current?.getBoundingClientRect();
      if (rect && box) setPosition({
        top: Math.max(12, Math.min(window.innerHeight - box.height - 12, rect.top - box.height - 8)),
        left: Math.max(12, Math.min(rect.left, window.innerWidth - box.width - 12)),
      });
    };
    place();
    const close = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    document.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); document.removeEventListener("scroll", place, true); window.removeEventListener("resize", place); };
  }, [open]);
  const billedInput = usage.input + usage.cacheRead + usage.cacheWrite;
  const cacheHit = billedInput > 0 ? Math.round(usage.cacheRead / billedInput * 100) : null;
  return <span ref={root} className={usageCss.root}>
    <button type="button" className={usageCss.trigger} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <IconDatabaseOutline16 /><span className={usageCss.label}>用量 {formatTokens(usage.totalTokens)}</span>
    </button>
    {open && createPortal(<div ref={panel} className={dialogCss.panel} role="dialog" aria-label="本轮用量" style={position ?? { top: -1000, left: -1000 }}>
      <div className={dialogCss.title}><span className={dialogCss.titleLabel}><IconDatabaseOutline16 />本轮用量</span><span className={dialogCss.titleValue}>{formatTokens(usage.totalTokens)}</span></div>
      <div className={dialogCss.titleRule} aria-hidden />
      <dl className={dialogCss.details}>
        {model && <><dt>提供方 / 模型</dt><dd className={dialogCss.route}>{model}</dd></>}
        {cacheHit !== null && <><dt>缓存命中</dt><dd>{cacheHit}%</dd></>}
        <dt>未缓存输入</dt><dd>{formatTokens(usage.input)}</dd>
        <dt>缓存读取</dt><dd>{formatTokens(usage.cacheRead)}</dd>
        <dt>缓存写入</dt><dd>{formatTokens(usage.cacheWrite)}</dd>
        <dt>输出</dt><dd>{formatTokens(usage.output)}{usage.reasoning !== undefined && <span className={dialogCss.reasoning}>（其中推理 {formatTokens(usage.reasoning)}）</span>}</dd>
      </dl>
    </div>, document.body)}
  </span>;
}

export function TurnActions({ text, timestamp, usage, model }: {
  text: string; timestamp?: string; usage: ViewUsage | null; model: string | null;
}) {
  const [copied, setCopied] = useState(false);
  return <div className={actionsCss.actions}>
    {text && <button className={actionsCss.action} type="button" aria-label={copied ? "已复制" : "复制回复"} onClick={() => { void navigator.clipboard.writeText(text).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1000); }); }}><IconCopyOutline16 /></button>}
    {usage && <UsagePill usage={usage} model={model} />}
    {timestamp && <time className={actionsCss.timeEnd} dateTime={timestamp}>{new Date(timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time>}
  </div>;
}
