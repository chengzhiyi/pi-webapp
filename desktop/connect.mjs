import { DesktopConnectionError } from "./backend.mjs";
import { localize as t } from "./locale.mjs";

function identityLines(identity) {
  if (!identity) return [];
  const pid = identity.pid ? ` · PID ${identity.pid}` : "";
  return [t(`后台：版本 ${identity.version} · ${identity.runtimeKind}${pid}`, `Backend: version ${identity.version} · ${identity.runtimeKind}${pid}`),
    ...(identity.cwd ? [t(`工作目录：${identity.cwd}`, `Working directory: ${identity.cwd}`)] : [])];
}

/** Recovery is intentionally non-destructive: no stop, upgrade or ownership transfer.
 * For a backend this shell did not start, the most it offers is the exact
 * `pi-webapp stop` command to copy; the user decides whether to run it. */
export async function connectBackend(backend, { showMessageBox, openExternal, checkDesktopUpdates, copyText, isInstalling = () => false }) {
  while (true) {
    let error;
    try { return await backend.connect(); }
    catch (value) {
      if (!(value instanceof DesktopConnectionError)) throw value;
      error = value;
    }
    const recheck = t("重新检查", "Check Again");
    const browser = t("在浏览器继续使用", "Continue in Browser");
    const copy = t("复制停止命令", "Copy Stop Command");
    const desktopUpdates = t("检查桌面更新", "Check for Desktop Updates");
    const command = error.backend?.stoppable && copyText && typeof backend.stopCommand === "function" ? backend.stopCommand() : undefined;
    const buttons = [recheck, ...(error.browserUrl ? [browser] : []), ...(command ? [copy] : []),
      ...(checkDesktopUpdates ? [desktopUpdates] : []), t("退出", "Quit")];
    const detail = [...identityLines(error.backend),
      t("现有后台及其任务保持运行。重新检查不会重启、升级或停止服务。", "The existing backend and its tasks keep running. Checking again will not restart, upgrade, or stop the service."),
      ...(command ? [t(`桌面应用不会停止不是它启动的服务。如果这是不再需要的残留或卡住的后台，可在终端运行：\n${command}\n若停止一直在等待，可在命令末尾加 --force 再运行一次；这会跳过插件保存确认，未保存的插件编辑可能丢失。`,
        `The desktop app never stops a service it did not start. If this is a leftover or hung backend you no longer need, run this in a terminal:\n${command}\nIf the stop keeps waiting, run it again with --force added. That skips plugin save confirmations, so unsaved plugin edits may be lost.`)] : [])];
    let copied = false;
    while (true) {
      const answer = await showMessageBox({ type: "warning", title: t("暂时无法连接已有服务", "Cannot connect to the existing service"),
        message: error.message,
        detail: [...detail, ...(copied ? [t("停止命令已复制到剪贴板。", "The stop command was copied to the clipboard.")] : [])].join("\n\n"),
        buttons, defaultId: buttons.length - 1, cancelId: buttons.length - 1, noLink: true });
      const choice = buttons[answer.response];
      if (choice === copy && command) {
        // Copying is display-only; re-show the dialog without re-probing the backend.
        copyText(command);
        copied = true;
        continue;
      }
      if (choice === recheck) break;
      if (choice === desktopUpdates && checkDesktopUpdates) {
        await checkDesktopUpdates();
        if (isInstalling()) return null;
        break;
      }
      if (choice === browser && error.browserUrl) {
        // Backend only supplies a loopback URL after authenticating the version endpoint.
        await openExternal(error.browserUrl);
      }
      return null;
    }
  }
}
