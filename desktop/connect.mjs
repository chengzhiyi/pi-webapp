import { DesktopConnectionError } from "./backend.mjs";
import { localize as t } from "./locale.mjs";

/** Recovery is intentionally non-destructive: no stop, upgrade or ownership transfer. */
export async function connectBackend(backend, { showMessageBox, openExternal, checkDesktopUpdates, isInstalling = () => false }) {
  while (true) {
    try { return await backend.connect(); }
    catch (error) {
      if (!(error instanceof DesktopConnectionError)) throw error;
      const recheck = t("重新检查", "Check Again");
      const browser = t("在浏览器继续使用", "Continue in Browser");
      const desktopUpdates = t("检查桌面更新", "Check for Desktop Updates");
      const buttons = [recheck, ...(error.browserUrl ? [browser] : []),
        ...(checkDesktopUpdates ? [desktopUpdates] : []), t("退出", "Quit")];
      const answer = await showMessageBox({ type: "warning", title: t("暂时无法连接已有服务", "Cannot connect to the existing service"),
        message: error.message,
        detail: t("现有后台及其任务保持运行。重新检查不会重启、升级或停止服务。", "The existing backend and its tasks keep running. Checking again will not restart, upgrade, or stop the service."),
        buttons, defaultId: buttons.length - 1, cancelId: buttons.length - 1, noLink: true });
      if (answer.response === 0) continue;
      if (checkDesktopUpdates && answer.response === buttons.indexOf(desktopUpdates)) {
        await checkDesktopUpdates();
        if (isInstalling()) return null;
        continue;
      }
      if (error.browserUrl && answer.response === 1) {
        // Backend only supplies a loopback URL after authenticating the version endpoint.
        await openExternal(error.browserUrl);
      }
      return null;
    }
  }
}
