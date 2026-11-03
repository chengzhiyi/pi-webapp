import { useEffect, useRef, useState } from "react";

/** Local observed run time, independent of whether its placeholder is visible.
 * Per-run start times survive chat switches while background work continues.
 * A monotonic clock avoids drift after throttled ticks or wall-clock changes.
 * Reloading starts new observations; no server execution time is fabricated. */
export function useActivityElapsed(active: boolean, sessionId: string | undefined, activityId = 0): number {
  const startedBySession = useRef(new Map<string, { activityId: number; started: number }>());
  const [clock, setClock] = useState<{ sessionId: string | undefined; activityId: number; seconds: number } | null>(null);
  useEffect(() => {
    if (!active || !sessionId) {
      if (sessionId) startedBySession.current.delete(sessionId);
      setClock(null);
      return;
    }
    const existing = startedBySession.current.get(sessionId);
    const started = existing?.activityId === activityId ? existing.started : performance.now();
    if (existing?.activityId !== activityId) startedBySession.current.set(sessionId, { activityId, started });
    const update = () => setClock({ sessionId, activityId, seconds: Math.max(0, Math.floor((performance.now() - started) / 1000)) });
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [active, sessionId, activityId]);
  return active && clock && clock.sessionId === sessionId && clock.activityId === activityId ? clock.seconds : 0;
}
