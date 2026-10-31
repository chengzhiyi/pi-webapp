import { useAppUpdate, type AppUpdateActions } from "./useAppUpdate.ts";
import { useAppUpdateContext, type AppUpdateController } from "./AppUpdateProvider.tsx";
import { useLocale, textFor } from "../locale/preference.ts";
import { Button } from "../primitives/Button.tsx";
import { SettingsSelect } from "./SettingsSelect.tsx";
import css from "./UpdateRow.module.css";

export function UpdateRow(props: AppUpdateActions) {
  const controller = useAppUpdateContext();
  return controller ? <UpdateRowContent {...props} controller={controller} /> : <StandaloneUpdateRow {...props} />;
}

function StandaloneUpdateRow(props: AppUpdateActions) {
  const controller = useAppUpdate(props);
  return <UpdateRowContent {...props} controller={controller} />;
}

function UpdateRowContent(props: AppUpdateActions & { controller: AppUpdateController }) {
  const locale = useLocale();
  const t = (zh: string, en: string) => textFor(locale, zh, en);
  const { status, checking, installing, cancelling, targetVersion, restartTimedOut, error, check, install, changeChannel, cancel } = props.controller;

  const summary = status
    ? `${t("当前版本", "Current version")} ${status.current}${status.latest ? ` · ${t("目标版本", "Target version")} ${status.latest}` : ""}`
    : checking ? t("正在读取版本…", "Reading version…") : t("暂时无法读取版本", "Version unavailable");

  return <section className={css.group} aria-label={t("应用更新", "App updates")}>
    {status?.channel && props.setUpdateChannel && <div className={css.preference}>
      <div className={css.title}>{t("更新偏好", "Update preference")}</div>
      <SettingsSelect label={t("更新偏好", "Update preference")} menuLabel={t("选择更新偏好", "Choose update preference")} value={status.channel} disabled={checking || installing || Boolean(targetVersion) || restartTimedOut} onChange={channel => { void changeChannel(channel); }} options={[
        { id: "stable", label: t("稳定版（推荐）", "Stable (recommended)") },
        { id: "alpha", label: t("体验版（包含 alpha）", "Preview (including alpha)") },
      ]} />
    </div>}
    {status?.channel === "alpha" && <p className={css.note}>{t("体验版包含尚在验证的新功能，可能不稳定。", "Preview releases include features still under testing and may be unstable.")}</p>}
    <div className={css.row}>
      <div className={css.details}>
        <div className={css.title}>{t("应用更新", "App updates")}</div>
        <p className={css.summary}>{summary}</p>
        {status?.desktopShell && <p className={css.summary}>{t("后台启动时的桌面外壳", "Desktop shell at backend startup")} {status.desktopShell.version} · build {status.desktopShell.build}</p>}
      </div>
      <div className={css.actions}>
        {status?.available && status.canRestart && !targetVersion && !restartTimedOut && <Button variant="primary" disabled={installing || checking} onClick={() => { void install(); }}>{installing ? t("正在安装…", "Installing…") : status.downgrade ? t("切换到稳定版并重启", "Switch to stable and restart") : t("升级并重启", "Update and restart")}</Button>}
        {(status?.recovery?.canCancel || installing) && props.cancelUpdate && !targetVersion && <Button variant="outline" disabled={cancelling} onClick={() => { void cancel(); }}>{cancelling ? t("正在取消…", "Cancelling…") : installing ? t("取消下载", "Cancel download") : t("取消未完成的升级", "Cancel unfinished update")}</Button>}
        <Button variant="outline" disabled={checking || installing || Boolean(targetVersion)} onClick={() => { void check(); }}>{checking ? t("检查中…", "Checking…") : t("检查更新", "Check for updates")}</Button>
      </div>
    </div>
    {status?.desktopShell && <p className={css.note}>{t("共享后台可能由旧版桌面启动。当前窗口的桌面版本请查看菜单「pi → 关于 pi」。业务包升级不会替换桌面应用。", "A shared backend may have been started by an older desktop. For this window’s desktop version, see pi → About pi. Updating the business package does not replace the desktop app.")}</p>}
    {status?.latest && !status.available && !checking && <p className={css.note} role="status">{t("已是最新版本", "Up to date")}</p>}
    {status?.reason && <p className={css.note}>{status.reason}</p>}
    {status?.requiresDesktopUpgrade && <p className={css.note}>
      <a href="https://github.com/chengzhiyi/pi-webapp/releases" target="_blank" rel="noreferrer">{t("下载新版桌面应用", "Download desktop update")}</a>
      {t("。安装支持更新通道的桌面版本后，可在此选择体验版并在线升级。", ". Install a desktop release with update-channel support, then return here to select preview and update online.")}
    </p>}
    {targetVersion && <p className={css.note} role="status">{t("正在重启并等待新版连接…", "Restarting and waiting for the new version…")}</p>}
    {error && <p className={css.error} role="alert">{error}</p>}
    {error?.includes("Missing view flush acknowledgement") && <p className={css.note}>{t("插件视图尚未确认保存。请保存并关闭绘图或编辑器；若视图已失联，请先在插件恢复记录中处理未确认的编辑，再重试升级。", "A plugin view has not confirmed its save. Save and close drawings or editors; if a view disconnected, review its unconfirmed edits in plugin recovery before retrying.")}</p>}
  </section>;
}
