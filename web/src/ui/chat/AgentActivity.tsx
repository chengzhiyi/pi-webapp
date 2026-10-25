import { localize as t } from "../locale/preference.ts";
import { IconLoadingOutline16 } from "../primitives/icons/index.tsx";
import chatCss from "./ChatView.module.css";
import css from "./AgentActivity.module.css";

/** Transient UI only: never stored as an assistant message or reasoning content. */
export function AgentActivity({ state, elapsedSeconds }: { state: "sending" | "working"; elapsedSeconds: number }) {
  return <div className={css.root} data-agent-activity={state}>
    <span className={css.icon} aria-hidden="true"><IconLoadingOutline16 /></span>
    <span className={`${chatCss.turnStatus} ${css.copy}`}>
      <span role="status" aria-live="polite" aria-atomic="true">{state === "sending" ? t("正在发送", "Sending") : t("正在处理", "Working")}</span>
      {/* Keep per-second ticks out of the live region to avoid repeated announcements. */}
      <span data-agent-elapsed={elapsedSeconds} aria-hidden="true">{t(`，用时 ${elapsedSeconds} 秒…`, `, ${elapsedSeconds}s elapsed…`)}</span>
    </span>
  </div>;
}
