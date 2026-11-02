let locale = "zh";

/** Use the operating-system language for native menus and dialogs. */
export function setDesktopLocale(value) {
  locale = String(value ?? "").toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function localize(zh, en) {
  return locale === "zh" ? zh : en;
}
