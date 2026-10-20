import { useCallback, useEffect, useState } from "react";

/** Hidden tabs do no work; focus, agent state changes and a bounded poll cover external edits. */
export function useWorkspaceGit<T>(read: (signal: AbortSignal) => Promise<T>, visible: boolean, idle: boolean, poll = true) {
  const [value, setValue] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => { setLoading(true); setRevision(current => current + 1); }, []);
  useEffect(() => {
    if (!visible) return;
    let disposed = false;
    let running = false;
    let pending = false;
    const controller = new AbortController();
    const update = async () => {
      if (disposed || document.visibilityState === "hidden") return;
      if (running) { pending = true; return; }
      running = true; setLoading(true);
      try {
        const result = await read(controller.signal);
        if (!disposed) { setValue(current => JSON.stringify(current) === JSON.stringify(result) ? current : result); setError(false); }
      } catch { if (!disposed) setError(true); }
      finally {
        running = false;
        if (!disposed) { setLoading(false); if (pending) { pending = false; void update(); } }
      }
    };
    void update();
    const timer = poll ? window.setInterval(() => { void update(); }, 5000) : undefined;
    const focus = () => { void update(); };
    window.addEventListener("focus", focus);
    window.addEventListener("pi-workspace-git-changed", focus);
    document.addEventListener("visibilitychange", focus);
    return () => {
      disposed = true; controller.abort(); window.clearInterval(timer);
      window.removeEventListener("pi-workspace-git-changed", focus);
      window.removeEventListener("focus", focus); document.removeEventListener("visibilitychange", focus);
    };
  }, [read, visible, idle, revision, poll]);
  return { value, loading, error, refresh };
}
