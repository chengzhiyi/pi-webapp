/** DSH's decimal K/M model-capacity spelling, adapted for Pi model settings. */
export function parseCapacity(text: string): number | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const match = /^(\d+(?:\.\d+)?)([km])?$/i.exec(trimmed);
  if (!match) return Number.NaN;
  const suffix = match[2]?.toLowerCase();
  const scale = suffix === "m" ? 1_000_000 : suffix === "k" ? 1_000 : 1;
  const scaled = Number(match[1]) * scale;
  const rounded = Math.round(scaled);
  return Math.abs(scaled - rounded) < 1e-6 ? rounded : scaled;
}

export function formatCapacity(value: number | undefined): string {
  if (value === undefined) return "";
  if (!Number.isInteger(value) || value <= 0) return String(value);
  if (value % 1_000_000 === 0) return `${value / 1_000_000}M`;
  if (value % 1_000 === 0) return `${value / 1_000}K`;
  return String(value);
}
