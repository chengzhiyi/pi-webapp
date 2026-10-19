import { useEffect, useState } from "react";
import type { UpdateStatus } from "./pi-bridge.ts";
import { useLocale, textFor } from "./ui/locale/preference.ts";
import { IconDownloadOutline16 } from "./ui/primitives/icons/index.tsx";
import { Modal } from "./ui/primitives/Modal.tsx";
import { Tooltip } from "./ui/primitives/Tooltip.tsx";
import { UpdateRow } from "./ui/settings/UpdateRow.tsx";
import css from "./PiUpdateShortcut.module.css";

type Props = React.ComponentProps<typeof UpdateRow> & { wide: boolean };

/** A quiet, always-reachable entry; installation still requires an explicit click. */
export function PiUpdateShortcut({ wide, ...updates }: Props) {
  const locale = useLocale();
  const t = (zh: string, en: string) => textFor(locale, zh, en);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let cancelled = false;
    // Check once per shell mount, not per conversation or focus event.
    void updates.getUpdate().then(status => {
      if (!cancelled) setAvailable(status.available);
    }).catch(() => { /* Background checks must not interrupt a conversation. */ });
    return () => { cancelled = true; };
  }, []);
  const getUpdate = async (): Promise<UpdateStatus> => {
    const status = await updates.getUpdate();
    setAvailable(status.available);
    return status;
  };
  const label = t("下载升级", "Download updates");
  return <>
    <div className={`pi-settings-trigger-row ${wide ? "" : "pi-settings-trigger-rail"}`}>
      <Tooltip label={available ? t("下载升级 · 有新版本", "Download updates · New version available") : label} disabled={wide}>
        <button className={`pi-settings-sidebar ${css.trigger}`} data-wide={wide} type="button" aria-label={label} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
          <span className={css.glyph}><IconDownloadOutline16 size={wide ? 16 : 18} />{available && <span className={css.dot} />}</span>
          {wide && <span>{label}</span>}
          {available && <span className={css.srOnly}>{t("有新版本", "New version available")}</span>}
        </button>
      </Tooltip>
    </div>
    <Modal open={open} onClose={() => { if (!busy) setOpen(false); }} title={label} closeLabel={t("关闭", "Close")} description={t("升级会重启服务并短暂断开连接，请在当前回复完成后操作。", "Updating restarts the service and briefly disconnects the app. Wait for the current reply to finish first.")}>
      <UpdateRow {...updates} getUpdate={getUpdate} onBusyChange={setBusy} />
    </Modal>
  </>;
}
