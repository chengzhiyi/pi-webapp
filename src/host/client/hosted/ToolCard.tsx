import { useId, useState, type ReactNode } from "react";
import type { ToolViewProps } from "../../../contracts/workbench.ts";
import { Modal } from "../../../../web/src/ui/primitives/Modal.tsx";
import { IconChevronDownOutline14 } from "../../../../web/src/ui/primitives/icons/index.tsx";
import css from "./tool-card.module.css";

/** Host chrome is independent of the plugin renderer and never reads its DOM. */
export function HostedToolCard({ title, tool, locale, children }: { title?: string; tool: Pick<ToolViewProps, "call" | "result" | "running">; locale: "zh" | "en"; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false), [details, setDetails] = useState(false);
  const bodyId = useId();
  const t = (zh: string, en: string) => locale === "zh" ? zh : en;
  const output = tool.result?.blocks.filter(block => block.kind === "text").map(block => block.text ?? "").join("\n");
  return <article className={title ? css.card : undefined} data-hosted-tool-card={title ? "" : undefined}>
    {title && <header className={css.header}>
      <button type="button" className={css.toggle} aria-label={t("展开或收起预览", "Toggle preview")} aria-expanded={!collapsed} aria-controls={bodyId} onClick={() => setCollapsed(value => !value)}>
        <span className={css.title}>{title}</span><span className={css.status}>{tool.result?.isError ? t("失败", "Failed") : tool.result ? t("已完成", "Completed") : tool.running ? t("运行中", "Running") : t("未完成", "Incomplete")}</span><span className={css.chevron} data-collapsed={collapsed} aria-hidden="true"><IconChevronDownOutline14 size={16} /></span>
      </button>
      <button type="button" className={css.parameters} aria-haspopup="dialog" onClick={() => setDetails(true)}>{t("查看参数", "View parameters")}</button>
    </header>}
    {/* Hiding retains the realm, pending edits, transport and barrier membership. */}
    <div id={bodyId} hidden={!!title && collapsed} className={css.preview}>{children}</div>
    <Modal open={details && !!title} onClose={() => setDetails(false)} title={t("工具参数", "Tool parameters")} closeLabel={t("关闭", "Close")} className={css.dialog}>
      <div className={css.details} data-tool-parameters><h3>{t("输入参数", "Input")}</h3><pre tabIndex={0}>{tool.call.text}</pre>{output !== undefined && <><h3>{t("工具结果", "Result")}</h3><pre tabIndex={0}>{output}</pre></>}</div>
    </Modal>
  </article>;
}
