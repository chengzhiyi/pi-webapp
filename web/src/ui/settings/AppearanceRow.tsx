/** Browser-local appearance preference row. */
import clsx from "clsx";
import { IconDarkOutline16, IconFollowsystemOutline16, IconLightOutline16 } from "../primitives/icons/index.tsx";
import { setThemePreference, useThemePreference, type ThemePreference } from "../theme/preference.ts";
import { useLocale } from "../locale/preference.ts";
import css from "./AppearanceRow.module.css";

export function AppearanceRow() {
  const preference = useThemePreference();
  const locale = useLocale();
  const choices: readonly { id: ThemePreference; label: string; Icon: typeof IconLightOutline16 }[] = [
    { id: "light", label: locale === "zh" ? "浅色" : "Light", Icon: IconLightOutline16 },
    { id: "dark", label: locale === "zh" ? "深色" : "Dark", Icon: IconDarkOutline16 },
    { id: "system", label: locale === "zh" ? "跟随系统" : "System", Icon: IconFollowsystemOutline16 },
  ];
  return <div className={css.group}>
    <div className={css.title}>{locale === "zh" ? "外观" : "Appearance"}</div>
    <div className={css.cubeRow}>{choices.map(({ id, label, Icon }) => <button
      key={id}
      type="button"
      className={clsx(css.themeCube, preference === id && css.selected)}
      aria-pressed={preference === id}
      onClick={() => setThemePreference(id)}
    ><Icon />{label}</button>)}</div>
  </div>;
}
