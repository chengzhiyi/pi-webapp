import { docsUrl, issuesUrl } from "../../../../desktop/docs-links.mjs";
import { textFor, type Locale } from "../locale/preference.ts";

export interface HelpLink { id: string; label: string; href: string }

/** The help entries shared by the sidebar menu and Settings, in the official docs' language. */
export function helpLinks(locale: Locale): HelpLink[] {
  const t = (zh: string, en: string) => textFor(locale, zh, en);
  return [
    { id: "docs", label: t("使用文档", "Documentation"), href: docsUrl("home", locale) },
    { id: "quick-start", label: t("快速开始", "Quick start"), href: docsUrl("quickStart", locale) },
    { id: "troubleshooting", label: t("故障排查", "Troubleshooting"), href: docsUrl("troubleshooting", locale) },
    { id: "issues", label: t("在 GitHub 上反馈问题", "Report an issue on GitHub"), href: issuesUrl },
  ];
}
