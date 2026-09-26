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
import { localize as t } from "../locale/preference.ts";

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
  const title = ({ bash: "Bash", pwsh: "PowerShell", read: t("读取", "Read"), write: t("写入", "Write"), edit: t("编辑", "Edit"), grep: t("搜索", "Search"), glob: t("搜索", "Search") } as Record<string, string>)[block.toolName || ""] || block.toolName || t("工具调用", "Tool call");
  const command = toolSummary(block);
  return <div className={toolCss.root} data-state={state} data-tool={block.toolName}>
    <DisclosureRow icon={<IconCodeOutline16 size={14} />} title={title} open={expanded} onToggle={() => setExpanded((value) => !value)}
      rowClassName={toolCss.row} leadingClassName={toolCss.leading} titleClassName={toolCss.title} chevronClassName={toolCss.chevron}
      collapsedContent={<><span className={toolCss.sep} aria-hidden /><span className={`${toolCss.summary} ${state === "error" ? toolCss.errorSummary : ""}`}>{state === "error" ? output?.split("\n", 1)[0] : command}</span></>}>
      <div className={toolCss.bodyWrap}>
        {shell ? <TerminalBlock command={command} cwd={cwd} output={output ?? undefined} running={output === null} exitCode={result?.isError ? 1 : result ? 0 : undefined} maxLines={Infinity} className={toolCss.terminalBody} labels={{
          signal: (signal) => t(`信号 ${signal}`, `Signal ${signal}`), exitCode: (code) => t(`退出码 ${code}`, `Exit code ${code}`), running: t("运行中", "Running"), failed: t("失败", "Failed"), done: t("已完成", "Done"), copy: t("复制", "Copy"), copied: t("已复制", "Copied"), noOutput: t("无输出", "No output"), collapseAria: t("收起输出", "Collapse output"), collapse: t("收起", "Collapse"), expandAria: (hidden) => t(`展开其余 ${hidden} 行输出`, `Expand remaining ${hidden} output lines`), expand: (hidden) => t(`… 其余 ${hidden} 行`, `… ${hidden} more lines`),
        }} /> : <div className={toolCss.ioCard}>
          <div className={toolCss.ioSection}><span className={toolCss.ioLabel}>IN</span><span className={toolCss.ioText}>{block.text}</span></div>
          {output !== null && <><span className={toolCss.ioDivider} aria-hidden /><div className={toolCss.ioSection}><span className={toolCss.ioLabel}>OUT</span><span className={toolCss.ioText} data-error={result?.isError || undefined}>{output || t("无文本输出", "No text output")}</span></div></>}
        </div>}
        {onInspect && <button className={toolCss.inspectButton} type="button" onClick={onInspect}>{t("查看轨迹", "View trajectory")}</button>}
      </div>
    </DisclosureRow>
  </div>;
}

/** Turn-level process disclosure. */
export function TurnProcess({ toolCount, messageCount, open, onToggle }: {
  toolCount: number; messageCount: number; open: boolean; onToggle: () => void;
}) {
  const labels = [toolCount > 0 && t(`${toolCount} 次工具调用`, `${toolCount} tool calls`), messageCount > 0 && t(`${messageCount} 条消息`, `${messageCount} messages`)].filter(Boolean);
  return <button type="button" className={processCss.root} data-open={open || undefined} aria-expanded={open} onClick={onToggle}>
    <span className={processCss.label}>{labels.length ? labels.join(" · ") : t("已思考", "Thought")}</span>
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
      <IconDatabaseOutline16 /><span className={usageCss.label}>{t("用量", "Usage")} {formatTokens(usage.totalTokens)}</span>
    </button>
    {open && createPortal(<div ref={panel} className={dialogCss.panel} role="dialog" aria-label={t("本轮用量", "Turn usage")} style={position ?? { top: -1000, left: -1000 }}>
      <div className={dialogCss.title}><span className={dialogCss.titleLabel}><IconDatabaseOutline16 />{t("本轮用量", "Turn usage")}</span><span className={dialogCss.titleValue}>{formatTokens(usage.totalTokens)}</span></div>
      <div className={dialogCss.titleRule} aria-hidden />
      <dl className={dialogCss.details}>
        {model && <><dt>{t("提供方 / 模型", "Provider / model")}</dt><dd className={dialogCss.route}>{model}</dd></>}
        {cacheHit !== null && <><dt>{t("缓存命中", "Cache hit")}</dt><dd>{cacheHit}%</dd></>}
        <dt>{t("未缓存输入", "Uncached input")}</dt><dd>{formatTokens(usage.input)}</dd>
        <dt>{t("缓存读取", "Cache read")}</dt><dd>{formatTokens(usage.cacheRead)}</dd>
        <dt>{t("缓存写入", "Cache write")}</dt><dd>{formatTokens(usage.cacheWrite)}</dd>
        <dt>{t("输出", "Output")}</dt><dd>{formatTokens(usage.output)}{usage.reasoning !== undefined && <span className={dialogCss.reasoning}>{t(`（其中推理 ${formatTokens(usage.reasoning)}）`, ` (including ${formatTokens(usage.reasoning)} reasoning)`)}</span>}</dd>
      </dl>
    </div>, document.body)}
  </span>;
}

export function TurnActions({ text, timestamp, usage, model }: {
  text: string; timestamp?: string; usage: ViewUsage | null; model: string | null;
}) {
  const [copied, setCopied] = useState(false);
  return <div className={actionsCss.actions}>
    {text && <button className={actionsCss.action} type="button" aria-label={copied ? t("已复制", "Copied") : t("复制回复", "Copy reply")} onClick={() => { void navigator.clipboard.writeText(text).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1000); }); }}><IconCopyOutline16 /></button>}
    {usage && <UsagePill usage={usage} model={model} />}
    {timestamp && <time className={actionsCss.timeEnd} dateTime={timestamp}>{new Date(timestamp).toLocaleTimeString(t("zh-CN", "en-US"), { hour: "2-digit", minute: "2-digit" })}</time>}
  </div>;
}
