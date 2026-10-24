import { useEffect, useRef, useState } from "react";
import type { UpdateStatus, UpdateChannel, UpdateRequest } from "../../../../src/host/client/pi-bridge.ts";
import { useLocale, textFor } from "../locale/preference.ts";
import { updateErrorMessage } from "./update-error.ts";
import { reportError } from "../../../../src/host/client/telemetry.ts";

export interface AppUpdateActions {
  getUpdate: () => Promise<UpdateStatus>;
  getRunningVersion: (signal?: AbortSignal) => Promise<{ current: string | null }>;
  setUpdateChannel?: (channel: UpdateChannel) => Promise<{ channel: UpdateChannel }>;
  update: (request?: UpdateRequest) => Promise<{ version: string }>;
}

/** Shared by Settings and the one-click shortcut, including restart readiness. */
export function useAppUpdate({ getUpdate, getRunningVersion, setUpdateChannel, update }: AppUpdateActions) {
  const locale = useLocale();
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [targetVersion, setTargetVersion] = useState<string | null>(null);
  const [restartTimedOut, setRestartTimedOut] = useState(false);
  const [error, setError] = useState("");
  const installLock = useRef(false);
  const checkSequence = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const check = async () => {
    const sequence = ++checkSequence.current;
    setChecking(true);
    setError("");
    try { const result = await getUpdate(); if (mounted.current && sequence === checkSequence.current) setStatus(result); }
    catch (cause) { if (mounted.current && sequence === checkSequence.current) { setStatus(null); setError(updateErrorMessage(cause, locale, "check")); } }
    finally { if (mounted.current && sequence === checkSequence.current) setChecking(false); }
  };
  useEffect(() => {
    void check();
    const refresh = () => { void check(); };
    window.addEventListener("pi-update-channel", refresh);
    return () => { window.removeEventListener("pi-update-channel", refresh); };
  }, []);

  const changeChannel = async (channel: UpdateChannel) => {
    if (!setUpdateChannel || checking || installing || targetVersion) return;
    ++checkSequence.current;
    setChecking(true); setError("");
    try {
      await setUpdateChannel(channel);
      // Settings and the sidebar shortcut must never retain different targets.
      window.dispatchEvent(new Event("pi-update-channel"));
    } catch (cause) {
      if (mounted.current) { setChecking(false); setError(updateErrorMessage(cause, locale, "check")); }
    }
  };

  useEffect(() => {
    if (!targetVersion) return;
    let cancelled = false;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const timeout = setTimeout(() => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
      setTargetVersion(null);
      setRestartTimedOut(true);
      setError(textFor(locale, "新版未能及时就绪，后台可能已回退到旧版。请刷新页面检查当前版本；若无法连接，请重新打开应用。", "The new version was not ready in time; the backend may have rolled back. Refresh to check the running version, or reopen the app if disconnected."));
      reportError(new Error("Updated service did not become ready within 60 seconds"), { stage: "update_restart", code: "update_restart_timeout", route: "/api/update/version", timeoutMs: 60_000 });
    }, 60_000);
    const poll = async () => {
      try {
        const result = await getRunningVersion(controller.signal);
        if (cancelled) return;
        if (result.current === targetVersion) { clearTimeout(timeout); location.reload(); return; }
      } catch { /* The old service is shutting down. */ }
      if (!cancelled) timer = setTimeout(() => { void poll(); }, 1200);
    };
    timer = setTimeout(() => { void poll(); }, 1200);
    return () => { cancelled = true; controller.abort(); clearTimeout(timer); clearTimeout(timeout); };
  }, [targetVersion]);

  const install = async () => {
    if (installLock.current || checking || !status?.available || !status.canRestart || targetVersion || restartTimedOut) return;
    if (status.downgrade && !window.confirm(textFor(locale,
      `将从 ${status.current} 切换至稳定版 ${status.latest}。部分新功能可能不可用；请先备份重要数据。是否继续？`,
      `Switch from ${status.current} to stable ${status.latest}? Some new features may be unavailable. Back up important data before continuing.`))) return;
    installLock.current = true;
    setInstalling(true);
    setError("");
    try { const result = await update(status.channel && status.latest ? { channel: status.channel, version: status.latest, ...(status.downgrade ? { allowDowngrade: true } : {}) } : undefined); if (mounted.current) setTargetVersion(result.version); }
    catch (cause) { if (mounted.current) setError(updateErrorMessage(cause, locale, "install")); }
    finally { installLock.current = false; if (mounted.current) setInstalling(false); }
  };
  return { status, checking, installing, targetVersion, restartTimedOut, error, check, install, changeChannel };
}
