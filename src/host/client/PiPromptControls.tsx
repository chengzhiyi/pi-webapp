import type { MouseEvent, ReactNode } from "react";
import { localize as t } from "../../../web/src/ui/locale/preference.ts";
import { Tooltip } from "../../../web/src/ui/shared/primitives/Tooltip.tsx";
import { IconSendOutlineMedium, IconStopFillRegular } from "../../../web/src/ui/shared/primitives/icons/index.tsx";
import inputCss from "../../../web/src/ui/conversation/InputBar.module.css";
import css from "./PiPromptControls.module.css";

interface Props {
  hasDraft: boolean;
  canSend: boolean;
  canStop: boolean;
  pauseLabel: string;
  pauseTitle?: string;
  pauseIcon?: ReactNode;
  onStop(): void;
}

/** DSH's plain Send queues the draft; per-row Send promotes it to steering. */
export function PiPromptControls({ hasDraft, canSend, canStop, pauseLabel, pauseTitle, pauseIcon, onStop }: Props) {
  const keepFocus = (event: MouseEvent<HTMLButtonElement>) => event.preventDefault();
  const pause = <Tooltip label={pauseTitle ?? pauseLabel} side="top" delayMs={500} disabled={!canStop}>
    <button className={hasDraft ? css.action : inputCss.primary} type="button" aria-label={pauseLabel} disabled={!canStop} onMouseDown={keepFocus} onClick={onStop}>
      {pauseIcon ?? <IconStopFillRegular size={16} />}
    </button>
  </Tooltip>;
  return <div className={css.controls} role="group" aria-label={t("追加提示词", "Append prompt")}>
    {pause}
    {hasDraft && <Tooltip label={t("当前任务完成后排队处理", "Queue after the current task finishes")} shortcutKeys={["Enter"]} side="top" delayMs={500} disabled={!canSend}>
      <button className={inputCss.primary} type="submit" aria-label={t("发送消息", "Send message")} disabled={!canSend} onMouseDown={keepFocus}><IconSendOutlineMedium size={16} /></button>
    </Tooltip>}
  </div>;
}
