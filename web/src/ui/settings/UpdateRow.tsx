import { useEffect, useState } from "react";
import type { UpdateStatus } from "../../pi-bridge.ts";
import { useLocale, textFor } from "../locale/preference.ts";
import { Button } from "../primitives/Button.tsx";
import { updateErrorMessage } from "./update-error.ts";
import { reportError } from "../../telemetry.ts";
import css from "./UpdateRow.module.css";

interface Props {
  getUpdate: () => Promise<UpdateStatus>;
  getRunningVersion: (signal?: AbortSignal) => Promise<{ current: string | null }>;
  update: () => Promise<{ version: string }>;
}

export function UpdateRow({ getUpdate, getRunningVersion, update }: Props) {
  const locale = useLocale();
  const t = (zh: string, en: string) => textFor(locale, zh, en);
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [targetVersion, setTargetVersion] = useState<string | null>(null);
  const [restartTimedOut, setRestartTimedOut] = useState(false);
  const [error, setError] = useState("");

  const check = async () => {
    setChecking(true);
    setError("");
    try { setStatus(await getUpdate()); }
    catch (cause) { setStatus(null); setError(updateErrorMessage(cause, locale, "check")); }
    finally { setChecking(false); }
  };
  useEffect(() => { void check(); }, []);

  useEffect(() => {
    if (!targetVersion) return;
    let cancelled = false;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    // An independent deadline also ends a poll whose request never returns.
    const timeout = setTimeout(() => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
      setTargetVersion(null);
      setRestartTimedOut(true);
      setError(t("新版启动超时。请运行 pi-webapp status 查看状态，或重新启动 pi-webapp。", "The new version did not start in time. Check pi-webapp status or start pi-webapp again."));
      reportError(new Error("Updated service did not become ready within 60 seconds"), { stage: "update_restart", code: "update_restart_timeout", route: "/api/update/version", timeoutMs: 60_000 });
    }, 60_000);
    const poll = async () => {
      try {
        const result = await getRunningVersion(controller.signal);
        if (cancelled) return;
        if (result.current === targetVersion) { clearTimeout(timeout); location.reload(); return; }
      } catch { /* The old service is shutting down. */ }
      if (cancelled) return;
      timer = setTimeout(() => { void poll(); }, 1200);
    };
    timer = setTimeout(() => { void poll(); }, 1200);
    return () => { cancelled = true; controller.abort(); clearTimeout(timer); clearTimeout(timeout); };
  }, [targetVersion]);

  const install = async () => {
    setInstalling(true);
    setError("");
    try { setTargetVersion((await update()).version); }
    catch (cause) { setError(updateErrorMessage(cause, locale, "install")); }
    finally { setInstalling(false); }
  };

  const summary = status
    ? `${t("当前版本", "Current version")} ${status.current}${status.latest ? ` · ${t("npm 最新版本", "Latest on npm")} ${status.latest}` : ""}`
    : checking ? t("正在读取版本…", "Reading version…") : t("暂时无法读取版本", "Version unavailable");

  return <section className={css.group} aria-label={t("应用更新", "App updates")}>
    <div className={css.row}>
      <div className={css.details}>
        <div className={css.title}>{t("应用更新", "App updates")}</div>
        <p className={css.summary}>{summary}</p>
      </div>
      <div className={css.actions}>
        {status?.available && status.canRestart && !targetVersion && !restartTimedOut && <Button variant="primary" disabled={installing || checking} onClick={() => { void install(); }}>{installing ? t("正在安装…", "Installing…") : t("升级并重启", "Update and restart")}</Button>}
        <Button variant="outline" disabled={checking || installing || Boolean(targetVersion)} onClick={() => { void check(); }}>{checking ? t("检查中…", "Checking…") : t("检查更新", "Check for updates")}</Button>
      </div>
    </div>
    {status && !status.available && !checking && <p className={css.note} role="status">{t("已是最新版本", "Up to date")}</p>}
    {status?.reason && <p className={css.note}>{status.reason}</p>}
    {targetVersion && <p className={css.note} role="status">{t("正在重启并等待新版连接…", "Restarting and waiting for the new version…")}</p>}
    {error && <p className={css.error} role="alert">{error}</p>}
  </section>;
}
