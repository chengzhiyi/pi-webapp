import { localize as t } from "../locale/preference.ts";
import chatCss from "./ChatView.module.css";
import css from "./AgentActivity.module.css";

/** Transient UI only: never stored as an assistant message or reasoning content. */
export function AgentActivity({ state }: { state: "sending" | "working" }) {
  return <div className={css.root} role="status" aria-live="polite" aria-atomic="true" data-agent-activity={state}>
    <span className={css.dots} aria-hidden="true"><i /><i /><i /></span>
    <span className={chatCss.turnStatus}>{state === "sending" ? t("正在发送…", "Sending…") : t("正在处理…", "Working…")}</span>
  </div>;
}
