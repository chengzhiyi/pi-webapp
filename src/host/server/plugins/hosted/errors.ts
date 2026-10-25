export class HostedPluginError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly reason?: string;
  constructor(code: string, message: string, details: { status?: number; reason?: string } = {}) {
    super(message); this.name = "HostedPluginError"; this.code = code;
    this.status = details.status; this.reason = details.reason;
  }
}
export interface HostedFailure { code: string; message: string; status?: number; reason?: string }
export function failure(error: unknown): HostedFailure {
  const value = error && typeof error === "object" ? error as { code?: unknown; status?: unknown; reason?: unknown } : {};
  return {
    code: typeof value.code === "string" && /^[\w.-]{1,80}$/.test(value.code) ? value.code : "plugin_failed",
    message: error instanceof Error ? error.message : "Plugin operation failed",
    ...(Number.isInteger(value.status) && Number(value.status) >= 400 && Number(value.status) <= 599 ? { status: Number(value.status) } : {}),
    ...(typeof value.reason === "string" && /^[\w.-]{1,80}$/.test(value.reason) ? { reason: value.reason } : {}),
  };
}
export const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
