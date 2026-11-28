import { localize as t } from "../../../web/src/ui/locale/preference.ts";
import { showToast } from "../../../web/src/ui/primitives/Toast.tsx";
import { useEffect, useSyncExternalStore } from "react";
import { accessToken, localFileGrant } from "./access-token.ts";
import { localFileActionHeader, localFileActionRoute, type FileActionPlatform as Platform, type FileActionTarget as Target, type FileActionResult as FileManagerResult, type SessionFileTarget, type ListFileAppsResult } from "../../contracts/local-file-actions.ts";
export type { SessionFileTarget, SystemFileApp } from "../../contracts/local-file-actions.ts";

type Kind = SessionFileTarget["kind"];

interface DesktopFileManager {
  readonly platform: Platform;
  show(target: Target): Promise<FileManagerResult>;
  listApps?(target: SessionFileTarget): Promise<ListFileAppsResult>;
  openWith?(target: SessionFileTarget, appId: string): Promise<FileManagerResult>;
}

declare global {
  interface Window { piDesktopFileManager?: DesktopFileManager }
}

let runtimeManager: DesktopFileManager | undefined;
let loading: Promise<void> | undefined;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const empty = () => undefined;

function getFileManager() {
  if (runtimeManager) return runtimeManager;
  // Compatibility with desktop launchers that do not supply the runtime grant yet.
  const bridge = typeof window === "undefined" ? undefined : window.piDesktopFileManager;
  return bridge?.platform === "darwin" || bridge?.platform === "win32" ? bridge : undefined;
}

function loadRuntimeManager() {
  const proof = localFileGrant();
  const token = accessToken();
  if (!proof || !token) return;
  const headers = { Authorization: `Bearer ${token}`, [localFileActionHeader]: proof };
  loading ??= (async () => {
    const response = await fetch(localFileActionRoute, { headers, redirect: "error" });
    if (!response.ok) return;
    const { platform } = await response.json();
    if (platform !== "darwin" && platform !== "win32") return;
    const operation = async <T extends FileManagerResult | ListFileAppsResult>(operation: "show" | "list" | "open", target: Target, appId?: string): Promise<T> => {
      const response = await fetch(localFileActionRoute, { method: "POST", redirect: "error", headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "sessionId" in target ? target.sessionId : "", operation, target, appId }) });
      const result = await response.json();
      if (response.ok || result?.ok === false) return result;
      throw new Error("Native file action unavailable");
    };
    runtimeManager = { platform,
      show: target => operation("show", target),
      listApps: target => operation("list", target),
      openWith: (target, appId) => operation("open", target, appId),
    };
    for (const listener of listeners) listener();
  })().catch(() => { loading = undefined; });
}

export function useFileManager() {
  const manager = useSyncExternalStore(subscribe, getFileManager, empty);
  useEffect(loadRuntimeManager, []);
  return manager;
}

export function fileManagerLabel(platform: Platform, kind: Kind) {
  if (platform === "darwin") return kind === "file" ? t("在访达中显示", "Show in Finder") : t("在访达中打开", "Open in Finder");
  return kind === "file" ? t("在文件资源管理器中显示", "Show in File Explorer") : t("在文件资源管理器中打开", "Open in File Explorer");
}

export function useSystemOpenWith() {
  const bridge = useFileManager();
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
