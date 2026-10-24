import { useAppUpdate, type AppUpdateActions } from "./useAppUpdate.ts";
import { useLocale, textFor } from "../locale/preference.ts";
import { Button } from "../primitives/Button.tsx";
import css from "./UpdateRow.module.css";

export function UpdateRow(props: AppUpdateActions) {
  const locale = useLocale();
  const t = (zh: string, en: string) => textFor(locale, zh, en);
  const { status, checking, installing, targetVersion, restartTimedOut, error, check, install, changeChannel } = useAppUpdate(props);

  const summary = status
    ? `${t("当前版本", "Current version")} ${status.current}${status.latest ? ` · ${t("目标版本", "Target version")} ${status.latest}` : ""}`
    : checking ? t("正在读取版本…", "Reading version…") : t("暂时无法读取版本", "Version unavailable");

  return <section className={css.group} aria-label={t("应用更新", "App updates")}>
    {status?.channel && props.setUpdateChannel && <label className={css.preference}>
      {t("更新偏好", "Update preference")}
      <select aria-label={t("更新偏好", "Update preference")} value={status.channel} disabled={checking || installing || Boolean(targetVersion) || restartTimedOut} onChange={event => { void changeChannel(event.target.value as "stable" | "alpha"); }}>
        <option value="stable">{t("稳定版（推荐）", "Stable (recommended)")}</option>
        <option value="alpha">{t("体验版（包含 alpha）", "Preview (including alpha)")}</option>
      </select>
    </label>}
    {status?.channel === "alpha" && <p className={css.note}>{t("体验版包含尚在验证的新功能，可能不稳定。", "Preview releases include features still under testing and may be unstable.")}</p>}
    <div className={css.row}>
      <div className={css.details}>
        <div className={css.title}>{t("应用更新", "App updates")}</div>
        <p className={css.summary}>{summary}</p>
        {status?.desktopShell && <p className={css.summary}>{t("桌面外壳", "Desktop shell")} {status.desktopShell.version} · build {status.desktopShell.build}</p>}
      </div>
      <div className={css.actions}>
        {status?.available && status.canRestart && !targetVersion && !restartTimedOut && <Button variant="primary" disabled={installing || checking} onClick={() => { void install(); }}>{installing ? t("正在安装…", "Installing…") : status.downgrade ? t("切换到稳定版并重启", "Switch to stable and restart") : t("升级并重启", "Update and restart")}</Button>}
        <Button variant="outline" disabled={checking || installing || Boolean(targetVersion)} onClick={() => { void check(); }}>{checking ? t("检查中…", "Checking…") : t("检查更新", "Check for updates")}</Button>
      </div>
    </div>
    {status?.latest && !status.available && !checking && <p className={css.note} role="status">{t("已是最新版本", "Up to date")}</p>}
    {status?.reason && <p className={css.note}>{status.reason}</p>}
    {targetVersion && <p className={css.note} role="status">{t("正在重启并等待新版连接…", "Restarting and waiting for the new version…")}</p>}
    {error && <p className={css.error} role="alert">{error}</p>}
  </section>;
}
