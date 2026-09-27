import { useEffect, useState } from "react";
import type { UpdateStatus } from "../../pi-bridge.ts";
import { useLocale, textFor } from "../locale/preference.ts";

interface Props {
  getUpdate: () => Promise<UpdateStatus>;
  getRunningVersion: () => Promise<{ current: string | null }>;
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
    catch (cause) { setError(cause instanceof Error ? cause.message : t("检查更新失败", "Could not check for updates")); }
    finally { setChecking(false); }
  };
  useEffect(() => { void check(); }, []);

  useEffect(() => {
    if (!targetVersion) return;
    let cancelled = false;
    const deadline = Date.now() + 60_000;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await getRunningVersion();
        if (result.current === targetVersion) { location.reload(); return; }
      } catch { /* The old service is shutting down. */ }
      if (cancelled) return;
      if (Date.now() >= deadline) {
        setTargetVersion(null);
        setRestartTimedOut(true);
        setError(t("新版启动超时。请运行 pi-webapp status 查看状态，或重新启动 pi-webapp。", "The new version did not start in time. Check pi-webapp status or start pi-webapp again."));
        return;
      }
      timer = setTimeout(() => { void poll(); }, 1200);
    };
    timer = setTimeout(() => { void poll(); }, 1200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [targetVersion]);

  const install = async () => {
    setInstalling(true);
    setError("");
    try { setTargetVersion((await update()).version); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("升级失败", "Update failed")); }
    finally { setInstalling(false); }
  };

  return <section className="pi-settings-section pi-update-section" aria-label={t("应用更新", "App updates")}>
    <h3>{t("应用更新", "App updates")}</h3>
    <p className="pi-settings-intro">{status ? `${t("当前版本", "Current version")} ${status.current}${status.latest ? ` · ${t("npm 最新版本", "Latest on npm")} ${status.latest}` : ""}` : t("正在读取版本…", "Reading version…")}</p>
    {status && !status.available && !checking && <p role="status">{t("已是最新版本", "Up to date")}</p>}
    {status?.reason && <p className="pi-settings-intro">{status.reason}</p>}
    {status?.available && status.canRestart && !targetVersion && !restartTimedOut && <button className="pi-settings-retry" type="button" disabled={installing} onClick={() => { void install(); }}>{installing ? t("正在安装新版…", "Installing update…") : t("升级并重启", "Update and restart")}</button>}
    {targetVersion && <p role="status">{t("正在重启并等待新版连接…", "Restarting and waiting for the new version…")}</p>}
    <button className="pi-settings-retry" type="button" disabled={checking || installing || Boolean(targetVersion)} onClick={() => { void check(); }}>{checking ? t("正在检查…", "Checking…") : t("检查更新", "Check for updates")}</button>
    {error && <p className="pi-settings-error" role="alert">{error}</p>}
  </section>;
}
