export interface ModelError {
  /** Human-readable message, unwrapped from the provider's JSON envelope when present. */
  message: string;
  status?: number;
  type?: string;
  requestId?: string;
  usageLimit: boolean;
  raw: string;
}

const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;

/** Providers report failures as `<status> <json>`; pull out the parts worth showing. */
export function parseModelError(raw: string): ModelError {
  const trimmed = raw.trim();
  const match = /^(?:(\d{3})\s*)?(\{[\s\S]*\})$/.exec(trimmed);
  let message = trimmed;
  let status = match?.[1] ? Number(match[1]) : undefined;
  let type: string | undefined;
  let requestId: string | undefined;
  if (match) {
    try {
      const body = JSON.parse(match[2]!) as Record<string, unknown>;
      const nested = body.error && typeof body.error === "object" ? body.error as Record<string, unknown> : undefined;
      message = text(nested?.message) ?? text(body.error) ?? text(body.message) ?? text(body.detail) ?? trimmed;
      type = text(nested?.type) ?? text(nested?.code) ?? (body.type !== "error" ? text(body.type) : undefined);
      requestId = text(body.request_id) ?? text(nested?.request_id);
      if (status === undefined && typeof body.status === "number") status = body.status;
    } catch { /* Not JSON after all; show the text as-is. */ }
  }
  return { message, status, type, requestId, usageLimit: /usage limit has been reached/i.test(trimmed), raw: trimmed };
}
