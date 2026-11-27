import { localize as t } from "../../../web/src/ui/locale/preference.ts";
import { showToast } from "../../../web/src/ui/primitives/Toast.tsx";

type Platform = "darwin" | "win32";
type Kind = "file" | "directory";
export type SessionFileTarget = { sessionId: string; path: string; kind: Kind };
type Target = SessionFileTarget | { workspaceId: string; path: ""; kind: "directory" };
export type FileManagerResult = { ok: true } | { ok: false; reason: "not-found" | "failed" };
export interface SystemFileApp { id: string; name: string; icon?: string; isDefault?: boolean }

interface DesktopFileManager {
  readonly platform: Platform;
  show(target: Target): Promise<FileManagerResult>;
  listApps?(target: SessionFileTarget): Promise<{ ok: true; apps: SystemFileApp[] } | Extract<FileManagerResult, { ok: false }>>;
  openWith?(target: SessionFileTarget, appId: string): Promise<FileManagerResult>;
}

declare global {
  interface Window { piDesktopFileManager?: DesktopFileManager }
}

export function getDesktopFileManager() {
  const bridge = typeof window === "undefined" ? undefined : window.piDesktopFileManager;
  return bridge?.platform === "darwin" || bridge?.platform === "win32" ? bridge : undefined;
}

export function fileManagerLabel(platform: Platform, kind: Kind) {
  if (platform === "darwin") return kind === "file" ? t("在访达中显示", "Show in Finder") : t("在访达中打开", "Open in Finder");
  return kind === "file" ? t("在文件资源管理器中显示", "Show in File Explorer") : t("在文件资源管理器中打开", "Open in File Explorer");
}

export function getDesktopOpenWith() {
  const bridge = getDesktopFileManager();
  return bridge?.listApps && bridge.openWith ? { platform: bridge.platform, show: bridge.show, listApps: bridge.listApps, openWith: bridge.openWith } : undefined;
}

export async function showInFileManager(bridge: DesktopFileManager, target: Target) {
  let reason: "not-found" | "failed" = "failed";
  try {
    const result = await bridge.show(target);
    if (result.ok) return;
    reason = result.reason;
  } catch { /* The desktop window or backend may have gone away. */ }
  fileManagerError(reason);
}

export function fileManagerError(reason: "not-found" | "failed", opening = false) {
  showToast({ key: "desktop-file-manager", message: reason === "not-found"
    ? t("找不到该文件或文件夹，请刷新列表后重试。", "File or folder not found. Refresh the list and try again.")
    : opening ? t("无法用所选应用打开。请重新选择应用后重试。", "Could not open with the selected app. Choose an app and try again.")
      : t("无法在系统文件管理器中显示该条目。", "Could not show this item in the system file manager.") });
}
