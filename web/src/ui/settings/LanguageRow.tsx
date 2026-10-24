import { useLocale, setLocalePreference, type Locale } from "../locale/preference.ts";
import { SettingsSelect } from "./SettingsSelect.tsx";
import css from "./LanguageRow.module.css";

const options: readonly { id: Locale; label: string }[] = [
  { id: "zh", label: "中文" },
  { id: "en", label: "English" },
];

export function LanguageRow() {
  const locale = useLocale();
  const label = locale === "zh" ? "语言" : "Language";
  return <div className={css.row}>
    <div className={css.title}>{label}</div>
    <SettingsSelect label={label} menuLabel={locale === "zh" ? "选择语言" : "Choose language"} value={locale} options={options} onChange={setLocalePreference} />
  </div>;
}
