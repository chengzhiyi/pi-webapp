/** Compact trailing labels matching DSH's relative-time hierarchy. */
export function sessionTimeLabel(modified: string, now: number, locale: "zh" | "en"): string {
  const timestamp = Date.parse(modified);
  if (!Number.isFinite(timestamp)) return "";
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 1) return locale === "zh" ? "刚刚" : "now";
  const values: [number, string, string][] = [
    [365 * 24 * 60, "年", "yr"], [30 * 24 * 60, "个月", "mo"],
    [7 * 24 * 60, "周", "wk"], [24 * 60, "天", "d"], [60, "小时", "h"], [1, "分钟", "min"],
  ];
  const [size, zh, en] = values.find(([size]) => minutes >= size)!;
  return `${Math.floor(minutes / size)}${locale === "zh" ? zh : en}`;
}
