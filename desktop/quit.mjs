import { localize as t } from "./locale.mjs";

/** A desktop-only exit must not depend on the backend's health or its ability to
 * flush plugin views. Only an explicitly confirmed stop may touch the service.
 */
export async function confirmDesktopQuit({ appName, backend, updater, showMessageBox }) {
  await updater?.assertQuitSafe(); // Native-staged updates may install on normal exit.
  if (backend?.owned) {
    const answer = await showMessageBox({ type: "warning", title: t(`退出 ${appName}`, `Quit ${appName}`),
      message: t("是否同时停止后台服务？", "Stop the background service too?"),
      detail: t("停止服务将结束所有聊天的运行任务和终端，也会断开正在使用该服务的浏览器。继续后台运行后，可重新打开桌面应用或使用 pi-webapp stop 停止。", "Stopping the service ends running tasks and terminals in every chat and disconnects browsers using it. If you keep it running, reopen the desktop app later or use pi-webapp stop to stop it."),
      buttons: [t("取消", "Cancel"), t("仅关窗口，后台继续", "Close Window, Keep Service Running"), t("停止服务并退出", "Stop Service and Quit")], defaultId: 0, cancelId: 0, noLink: true });
    if (answer.response !== 1 && answer.response !== 2) return false;
    if (answer.response === 2) {
      try { await backend.stop(); }
      catch (error) {
        const recovery = await showMessageBox({ type: "warning", title: t("后台尚未停止", "Background service has not stopped"),
          message: t("可以返回应用处理保存问题，或仅退出桌面。", "Return to the app to resolve saving issues, or quit only the desktop."),
          detail: `${error.message}\n\n${t("仅退出桌面不会强制终止后台。若停止请求仍在处理中，后台可能在完成后退出；未确认保存的编辑仍需在原视图中处理。", "Quitting only the desktop does not forcibly stop the background service. If a stop request is still being processed, the service may exit after it completes. Unconfirmed edits must still be handled in their original views.")}`,
          buttons: [t("返回应用", "Return to App"), t("仅退出桌面", "Quit Desktop Only")], defaultId: 0, cancelId: 0, noLink: true });
        if (recovery.response !== 1) return false;
      }
    }
  } else if (backend) {
    const answer = await showMessageBox({ type: "info", title: t("关闭桌面应用", "Close Desktop App"),
      message: t("当前连接的是已有服务，关闭桌面不会停止它。", "You are connected to an existing service. Closing the desktop app will not stop it."), buttons: [t("取消", "Cancel"), t("关闭桌面", "Close Desktop")], defaultId: 0, cancelId: 0 });
    if (answer.response !== 1) return false;
  }
  await updater?.assertQuitSafe(); // Recheck after an asynchronous stop or confirmation.
  return true;
}
