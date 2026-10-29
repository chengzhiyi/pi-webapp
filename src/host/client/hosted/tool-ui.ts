/** Data-only UI messages on the existing identity-bound MessagePort. */
export function toolPresentation(input: unknown): { title: string } {
  const value = input as { title?: unknown };
  if (typeof value?.title !== "string" || !value.title.trim() || value.title.length > 160) throw new Error("Invalid tool presentation");
  return { title: value.title };
}
export function toolHeight(input: unknown): number {
  const height = (input as { height?: unknown })?.height;
  if (typeof height !== "number" || !Number.isFinite(height) || height < 0 || height > 4096) throw new Error("Invalid tool height");
  return Math.max(1, Math.ceil(height));
}
export function notification(input: unknown): { message: string; level: "info" | "error" } {
  const value = input as { message?: unknown; level?: unknown };
  if (typeof value?.message !== "string" || value.message.length > 4000 || value.level !== "info" && value.level !== "error") throw new Error("Invalid notification");
  return { message: value.message, level: value.level };
}
