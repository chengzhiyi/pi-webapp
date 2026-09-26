/** Browser-local appearance preference row. */
import clsx from "clsx";
import { IconDarkOutline16, IconFollowsystemOutline16, IconLightOutline16 } from "../primitives/icons/index.tsx";
import { setThemePreference, useThemePreference, type ThemePreference } from "../theme/preference.ts";
import css from "./AppearanceRow.module.css";

const choices: readonly { id: ThemePreference; label: string; Icon: typeof IconLightOutline16 }[] = [
  { id: "light", label: "浅色", Icon: IconLightOutline16 },
  { id: "dark", label: "深色", Icon: IconDarkOutline16 },
  { id: "system", label: "跟随系统", Icon: IconFollowsystemOutline16 },
];

export function AppearanceRow() {
  const preference = useThemePreference();
  return <div className={css.group}>
    <div className={css.title}>外观</div>
    <div className={css.cubeRow}>{choices.map(({ id, label, Icon }) => <button
      key={id}
      type="button"
      className={clsx(css.themeCube, preference === id && css.selected)}
      aria-pressed={preference === id}
      onClick={() => setThemePreference(id)}
    ><Icon />{label}</button>)}</div>
  </div>;
}
