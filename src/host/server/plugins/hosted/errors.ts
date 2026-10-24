export class HostedPluginError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = "HostedPluginError"; this.code = code; }
}
export function failure(error: unknown): { code: string; message: string } {
  return error instanceof HostedPluginError ? { code: error.code, message: error.message }
    : { code: "plugin_failed", message: error instanceof Error ? error.message : "Plugin operation failed" };
}
export const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
