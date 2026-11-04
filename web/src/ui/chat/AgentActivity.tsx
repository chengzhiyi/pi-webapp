import { localize as t } from "../locale/preference.ts";
import chatCss from "./ChatView.module.css";
import { formatElapsedSeconds } from "./format-elapsed.ts";
import css from "./AgentActivity.module.css";

/** Transient UI only: never stored as an assistant message or reasoning content. */
export function AgentActivity({ state, elapsedSeconds }: { state: "sending" | "working"; elapsedSeconds: number }) {
  return <div className={css.root} data-agent-activity={state}>
    <span className={css.icon} aria-hidden="true">
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor">
        <circle className={css.orbit} cx="10" cy="10" r="9" strokeWidth="1" strokeDasharray="3.5 2.5" strokeLinecap="round" />
        <circle className={css.ripple} cx="10" cy="10" r="7.5" strokeWidth="1.25" />
        <circle className={`${css.ripple} ${css.rippleLate}`} cx="10" cy="10" r="7.5" strokeWidth="1.25" />
        <circle className={css.core} cx="10" cy="10" r="4" fill="currentColor" stroke="none" />
      </svg>
    </span>
    <span className={`${chatCss.turnStatus} ${css.copy}`}>
      <span role="status" aria-live="polite" aria-atomic="true">{state === "sending" ? t("正在发送", "Sending") : t("正在处理", "Working")}</span>
      {/* Keep per-second ticks out of the live region to avoid repeated announcements. */}
      <span data-agent-elapsed={elapsedSeconds} aria-hidden="true">{` · ${formatElapsedSeconds(elapsedSeconds)}`}</span>
    </span>
  </div>;
}
