import { useEffect, useState } from "react";
import { localize as t } from "../../../web/src/ui/locale/preference.ts";
import { IconLoadingOutline16 } from "../../../web/src/ui/primitives/icons/index.tsx";
import { IconChevronRightOutlineRegular } from "../../../web/src/ui/shared/primitives/icons/index.tsx";
import { followActivity } from "../../plugins/builtin/activity/client/activity-api.ts";
import type { ActivitySnapshot } from "../../plugins/builtin/activity/contract/activity.ts";
import { HttpError } from "./http-error.ts";
import css from "../../../web/src/ui/chat/BackgroundActivity.module.css";

const runningCount = (snapshot: ActivitySnapshot) => snapshot.items.filter(item => item.status === "running" || item.status === "paused").length;

/** Compact chat entry point. It never invents activity while disconnected or on older hosts. */
export function BackgroundActivity({ sessionId, enabled, onOpen }: { sessionId: string; enabled: boolean; onOpen(): void }) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    setCount(0);
    if (!enabled) return;
    let alive = true;
    let controller: AbortController | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const follow = async () => {
      while (alive) {
        controller = new AbortController();
        try {
          await followActivity(sessionId, controller.signal, snapshot => {
            if (snapshot.closed) throw new Error("Activity session was replaced");
            if (alive) setCount(runningCount(snapshot));
          });
          if (alive) throw new Error("Activity stream closed");
        } catch (cause) {
          if (!alive || controller.signal.aborted) return;
          setCount(0);
          // A disabled plugin, old bridge or host without Activity has no retry loop.
          if (cause instanceof HttpError && [403, 404, 503].includes(cause.status)) return;
          await new Promise<void>(resolve => { retry = setTimeout(resolve, 1500); });
        }
      }
    };
    void follow();
    return () => { alive = false; controller?.abort(); if (retry) clearTimeout(retry); };
  }, [sessionId, enabled]);

  if (!enabled || count === 0) return null;
  const label = t(`查看后台任务，${count} 个运行中`, `View background tasks, ${count} running`);
  return <button type="button" className={css.root} data-background-activity aria-label={label} title={label} onClick={onOpen}>
    <span className={css.icon} aria-hidden="true"><IconLoadingOutline16 /></span>
    <span role="status" aria-live="polite" aria-atomic="true">Background · {count} {count === 1 ? "task" : "tasks"}</span>
    <span className={css.chevron} aria-hidden="true"><IconChevronRightOutlineRegular size={12} /></span>
  </button>;
}
