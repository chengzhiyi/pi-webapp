/** A desktop-only exit must not depend on the backend's health or its ability to
 * flush plugin views. Only an explicitly confirmed stop may touch the service.
 */
export async function confirmDesktopQuit({ appName, backend, updater, showMessageBox }) {
  await updater?.assertQuitSafe(); // Native-staged updates may install on normal exit.
  if (backend?.owned) {
    const answer = await showMessageBox({ type: "warning", title: `退出 ${appName}`,
      message: "是否同时停止后台服务？",
      detail: "停止服务将结束所有聊天的运行任务和终端，也会断开正在使用该服务的浏览器。继续后台运行后，可重新打开桌面应用或使用 pi-webapp stop 停止。",
      buttons: ["取消", "仅关窗口，后台继续", "停止服务并退出"], defaultId: 0, cancelId: 0, noLink: true });
    if (answer.response !== 1 && answer.response !== 2) return false;
    if (answer.response === 2) {
      try { await backend.stop(); }
      catch (error) {
        const recovery = await showMessageBox({ type: "warning", title: "后台尚未停止",
          message: "可以返回应用处理保存问题，或仅退出桌面。",
          detail: `${error.message}\n\n仅退出桌面不会强制终止后台。若停止请求仍在处理中，后台可能在完成后退出；未确认保存的编辑仍需在原视图中处理。`,
          buttons: ["返回应用", "仅退出桌面"], defaultId: 0, cancelId: 0, noLink: true });
        if (recovery.response !== 1) return false;
      }
    }
  } else if (backend) {
    const answer = await showMessageBox({ type: "info", title: "关闭桌面应用",
      message: "当前连接的是已有服务，关闭桌面不会停止它。", buttons: ["取消", "关闭桌面"], defaultId: 0, cancelId: 0 });
    if (answer.response !== 1) return false;
  }
  await updater?.assertQuitSafe(); // Recheck after an asynchronous stop or confirmation.
  return true;
}
