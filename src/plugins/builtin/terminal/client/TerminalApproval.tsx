import { useState } from "react";
import type { WebInteraction } from "@chengzhiyi/pi-web-protocol";
import { Button } from "../../../../../web/src/ui/shared/primitives/Button.tsx";
import { metadata } from "../contract/manifest.ts";
import { TERMINAL_INPUT_APPROVAL, type TerminalInputApproval, type TerminalInputDecision } from "../contract/terminal.ts";
import css from "./terminal-approval.module.css";

/** A pending request from the agent to type into a terminal, if `request` is one. */
export function terminalApproval(request: WebInteraction | undefined): (TerminalInputApproval & { requestId: string }) | null {
  if (!request || request.pluginId !== metadata.id || request.kind !== TERMINAL_INPUT_APPROVAL) return null;
  const data = request.data as Partial<TerminalInputApproval> | null;
  if (!data || typeof data.terminalId !== "string" || typeof data.text !== "string" || typeof data.enter !== "boolean") return null;
  return { requestId: request.requestId, terminalId: data.terminalId, text: data.text, enter: data.enter };
}

const copy = {
  zh: { title: "Pi 想在终端中输入", hint: "允许后会在你的终端里执行，与你亲自输入相同。", noEnter: "（不按回车）", allow: "允许", deny: "拒绝", failed: "未能提交决定，请重试。" },
  en: { title: "Pi wants to type into the terminal", hint: "If you allow it, it runs in your shell as if you typed it.", noEnter: "(without pressing Enter)", allow: "Allow", deny: "Deny", failed: "Could not submit your decision. Try again." },
};

/** Explicit per-call consent: shows the exact text, never remembered, never auto-dismissed. */
export function TerminalApproval({ approval, locale, decide, overlay = false }: { approval: TerminalInputApproval; locale: "zh" | "en"; decide(value: TerminalInputDecision): Promise<void>; overlay?: boolean }) {
  const t = copy[locale];
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const answer = (allow: boolean) => {
    setBusy(true); setFailed(false);
    decide({ allow }).catch(() => { setFailed(true); setBusy(false); });
  };
  return <section role="alertdialog" aria-label={t.title} data-terminal-approval={approval.terminalId} data-approval-place={overlay ? "terminal" : "composer"} className={overlay ? `${css.card} ${css.overlay}` : css.card}>
    <strong className={css.title}>{t.title}</strong>
    <pre className={css.command}>{approval.text}{approval.enter ? <span aria-hidden="true" className={css.enter}> ⏎</span> : null}</pre>
    {!approval.enter && <span className={css.hint}>{t.noEnter}</span>}
    <span className={css.hint}>{t.hint}</span>
    {failed && <span role="alert" className={css.error}>{t.failed}</span>}
    <div className={css.actions}>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => answer(false)}>{t.deny}</Button>
      <Button size="sm" variant="primary" disabled={busy} onClick={() => answer(true)}>{t.allow}</Button>
    </div>
  </section>;
}
