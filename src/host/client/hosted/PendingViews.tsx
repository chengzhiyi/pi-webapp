import { useEffect, useState } from "react";
import type { HostedPendingView } from "../../../contracts/hosted-plugins.ts";
import { Button } from "../../../../web/src/ui/primitives/Button.tsx";
import { hostedApi } from "./api.ts";
import css from "./management.module.css";

/** Views the host still holds for a plugin. After a barrier timeout this is the only way to
 * resolve one whose window is gone: discarding is explicit and never counts as a save. */
export function PendingViews({ pluginId, t }: { pluginId: string; t: (zh: string, en: string) => string }) {
  const [views, setViews] = useState<HostedPendingView[] | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [error, setError] = useState(""), [working, setWorking] = useState(false), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    hostedApi.pendingViews(pluginId).then(value => { if (alive) setViews(value.views); }).catch(cause => { if (alive) setError(String(cause)); });
    return () => { alive = false; };
  }, [pluginId, attempt]);
  const discard = async (view: HostedPendingView) => {
    setWorking(true); setError("");
    try {
      await hostedApi.view({ pluginId: view.pluginId, sessionId: view.sessionId, generation: view.generation, mountId: view.mountId, viewToken: view.viewToken, operation: "discard", confirmation: "discard-unconfirmed-edits" });
      setConfirm(null); setAttempt(value => value + 1);
    } catch (cause) { setError(String(cause)); } finally { setWorking(false); }
  };
  if (!views?.length && !error) return null;
  return <div className={css.error} data-pending-views>
    <p>{t("宿主仍持有以下视图。若原窗口已关闭，可丢弃该视图后重试；仍打开的窗口请先保存并关闭。丢弃不会保存内容，无法找回的修改可能永久丢失。", "The host still holds these views. If the original window is closed, discard the view and retry; save and close windows that are still open first. Discarding does not save content; unrecovered edits may be permanently lost.")}</p>
    {views?.map(view => <div key={view.viewToken}>
      <code>{view.kind} · {view.mountId} · {t("会话", "session")} {view.sessionId}{view.dirty || view.busy ? ` · ${t("有未确认修改", "unconfirmed edits")}` : ""}</code>{" "}
      {confirm === view.viewToken
        ? <><Button variant="outline" size="sm" disabled={working} onClick={() => void discard(view)}>{t("确认丢弃", "Confirm discard")}</Button> <Button variant="outline" size="sm" disabled={working} onClick={() => setConfirm(null)}>{t("取消", "Cancel")}</Button></>
        : <Button variant="outline" size="sm" disabled={working} onClick={() => setConfirm(view.viewToken)}>{t("丢弃此视图", "Discard this view")}</Button>}
    </div>)}
    {error && <p role="alert">{error}</p>}
  </div>;
}
