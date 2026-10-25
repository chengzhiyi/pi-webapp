import { useEffect, useState } from "react";

/** Local observed run time, independent of whether its placeholder is visible.
 * A monotonic clock avoids drift after throttled ticks or wall-clock changes.
 * Reloading starts a new observation; no server execution time is fabricated. */
export function useActivityElapsed(active: boolean, sessionId: string | undefined): number {
  const [clock, setClock] = useState<{ sessionId: string | undefined; seconds: number } | null>(null);
  useEffect(() => {
    if (!active) { setClock(null); return; }
    const started = performance.now();
    setClock({ sessionId, seconds: 0 });
    const timer = window.setInterval(() => {
      setClock({ sessionId, seconds: Math.max(0, Math.floor((performance.now() - started) / 1000)) });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [active, sessionId]);
  return active && clock && clock.sessionId === sessionId ? clock.seconds : 0;
}
