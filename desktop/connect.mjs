import { DesktopConnectionError } from "./backend.mjs";

/** Recovery is intentionally non-destructive: no stop, upgrade or ownership transfer. */
export async function connectBackend(backend, { showMessageBox, openExternal }) {
  while (true) {
    try { return await backend.connect(); }
    catch (error) {
      if (!(error instanceof DesktopConnectionError)) throw error;
      const buttons = ["重新检查", ...(error.browserUrl ? ["在浏览器继续使用"] : []), "退出"];
      const answer = await showMessageBox({ type: "warning", title: "暂时无法连接已有服务",
        message: error.message,
        detail: "现有后台及其任务保持运行。重新检查不会重启、升级或停止服务。",
        buttons, defaultId: buttons.length - 1, cancelId: buttons.length - 1, noLink: true });
      if (answer.response === 0) continue;
      if (error.browserUrl && answer.response === 1) {
        // Backend only supplies a loopback URL after authenticating the version endpoint.
        await openExternal(error.browserUrl);
      }
      return null;
    }
  }
}
