import { useLocale, textFor } from "../../../web/src/ui/locale/preference.ts";
import { IconDownloadOutline16 } from "../../../web/src/ui/primitives/icons/index.tsx";
import { Tooltip } from "../../../web/src/ui/primitives/Tooltip.tsx";
import { useAppUpdate, type AppUpdateActions } from "../../../web/src/ui/settings/useAppUpdate.ts";
import { useAppUpdateContext, type AppUpdateController } from "../../../web/src/ui/settings/AppUpdateProvider.tsx";
import css from "./PiUpdateShortcut.module.css";

type Props = AppUpdateActions & { wide: boolean; hideError?: boolean };

/** Only actionable releases appear here; a single click starts the update. */
export function PiUpdateShortcut(props: Props) {
  const controller = useAppUpdateContext();
  return controller ? <UpdateShortcutContent {...props} controller={controller} /> : <StandaloneUpdateShortcut {...props} />;
}

function StandaloneUpdateShortcut(props: Props) {
  const controller = useAppUpdate(props);
  return <UpdateShortcutContent {...props} controller={controller} />;
}

function UpdateShortcutContent({ wide, hideError, controller }: Props & { controller: AppUpdateController }) {
  const locale = useLocale();
  const t = (zh: string, en: string) => textFor(locale, zh, en);
  const { status, checking, installing, targetVersion, restartTimedOut, error, install } = controller;
  if (!status?.available || !status.canRestart) return null;
  const label = installing ? t("正在升级…", "Updating…")
    : targetVersion ? t("正在重启…", "Restarting…")
    : status.downgrade ? t("切换到稳定版", "Switch to stable") : t("下载升级", "Download updates");
  const hint = error || (status.downgrade ? t("按更新偏好切换到稳定版，需要确认后重启", "Switch to stable based on your preference; confirmation and restart required") : t("下载并升级到新版本，服务将短暂重启", "Download and update to the new version; the service will briefly restart"));
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
    {error && !hideError && <p className={wide ? css.error : css.srOnly} role="alert">{error}</p>}
  </div>;
}
