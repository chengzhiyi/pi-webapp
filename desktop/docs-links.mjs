// Official documentation addresses, shared by the native Help menu and the web UI.
// Chinese pages live under /zh/; English pages sit at the site root.
export const docsOrigin = "https://pi.emath.top";
export const issuesUrl = "https://github.com/chengzhiyi/pi-webapp/issues";

/** @param {"home" | "quickStart" | "troubleshooting"} page @param {string} locale */
export function docsUrl(page, locale) {
  const path = { home: "", quickStart: "getting-started", troubleshooting: "troubleshooting" }[page];
  return `${docsOrigin}/${String(locale).toLowerCase().startsWith("zh") ? "zh/" : ""}${path}`;
}

/** Links to the official documentation open without the generic external-link prompt. */
export function isDocsAddress(value) {
  try { return new URL(value).origin === docsOrigin; } catch { return false; }
}
