import { useLocale, textFor } from "../locale/preference.ts";
import { helpLinks } from "./help-links.ts";
import css from "./HelpRow.module.css";

/** Settings → General entry point for the official documentation. */
export function HelpRow() {
  const locale = useLocale();
  const t = (zh: string, en: string) => textFor(locale, zh, en);
  return <section className={css.row} aria-label={t("帮助与文档", "Help & documentation")}>
    <div className={css.title}>{t("帮助与文档", "Help & documentation")}</div>
    <p className={css.summary}>{t("查看使用指南、快速开始和常见问题的解决方法。", "Read the guides, get started quickly, and find fixes for common problems.")}</p>
    <ul className={css.links}>{helpLinks(locale).map(link => <li key={link.id}>
      <a href={link.href} target="_blank" rel="noreferrer">{link.label}</a>
    </li>)}</ul>
  </section>;
}
