import { useLocale, textFor } from "../../../web/src/ui/locale/preference.ts";
import { IconDownloadOutline16 } from "../../../web/src/ui/primitives/icons/index.tsx";
import { Tooltip } from "../../../web/src/ui/primitives/Tooltip.tsx";
import { useAppUpdate, type AppUpdateActions } from "../../../web/src/ui/settings/useAppUpdate.ts";
import css from "./PiUpdateShortcut.module.css";

type Props = AppUpdateActions & { wide: boolean };

/** Only actionable releases appear here; a single click starts the update. */
export function PiUpdateShortcut({ wide, ...updates }: Props) {
  const locale = useLocale();
  const t = (zh: string, en: string) => textFor(locale, zh, en);
  const { status, checking, installing, targetVersion, restartTimedOut, error, install } = useAppUpdate(updates);
  if (!status?.available || !status.canRestart) return null;
  const label = installing ? t("正在升级…", "Updating…")
    : targetVersion ? t("正在重启…", "Restarting…")
    : t("下载升级", "Download updates");
  const hint = error || t("下载并升级到新版本，服务将短暂重启", "Download and update to the new version; the service will briefly restart");
  return <div className={css.root}>
    <div className={`pi-settings-trigger-row ${wide ? "" : "pi-settings-trigger-rail"}`}>
      <Tooltip label={hint}>
        <button className={`pi-settings-sidebar ${css.trigger}`} data-wide={wide} type="button" aria-label={label} disabled={checking || installing || Boolean(targetVersion) || restartTimedOut} onClick={() => { void install(); }}>
          <span className={css.glyph}><IconDownloadOutline16 size={wide ? 16 : 18} /><span className={css.dot} /></span>
          {wide && <span>{label}</span>}
        </button>
      </Tooltip>
    </div>
    {(installing || targetVersion) && <span className={css.srOnly} role="status">{label}</span>}
    {error && <p className={wide ? css.error : css.srOnly} role="alert">{error}</p>}
  </div>;
}
