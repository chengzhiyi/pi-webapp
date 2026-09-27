import { HttpError } from "../../http-error.ts";

export function updateErrorMessage(cause: unknown, locale: "zh" | "en", action: "check" | "install"): string {
  if (cause instanceof HttpError && cause.status === 404) {
    return locale === "zh"
      ? "后台服务仍在运行旧版。请重启 pi-webapp 后重新打开页面，再检查更新。"
      : "The background service is still running an older version. Restart pi-webapp, reopen this page, then check again.";
  }
  if (cause instanceof Error && cause.message) return cause.message;
  if (action === "check") return locale === "zh" ? "检查更新失败" : "Could not check for updates";
  return locale === "zh" ? "升级失败" : "Update failed";
}
