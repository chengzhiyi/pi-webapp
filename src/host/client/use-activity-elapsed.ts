import { useEffect, useRef, useState } from "react";

/** Local observed run time, independent of whether its placeholder is visible.
 * Per-session start times survive chat switches while background work continues.
 * A monotonic clock avoids drift after throttled ticks or wall-clock changes.
 * Reloading starts new observations; no server execution time is fabricated. */
export function useActivityElapsed(active: boolean, sessionId: string | undefined): number {
  const startedBySession = useRef(new Map<string, number>());
  const [clock, setClock] = useState<{ sessionId: string | undefined; seconds: number } | null>(null);
  useEffect(() => {
    if (!active || !sessionId) {
      if (sessionId) startedBySession.current.delete(sessionId);
      setClock(null);
      return;
    }
    const existing = startedBySession.current.get(sessionId);
    const started = existing ?? performance.now();
    if (existing === undefined) startedBySession.current.set(sessionId, started);
    const update = () => setClock({ sessionId, seconds: Math.max(0, Math.floor((performance.now() - started) / 1000)) });
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [active, sessionId]);
  return active && clock && clock.sessionId === sessionId ? clock.seconds : 0;
}
