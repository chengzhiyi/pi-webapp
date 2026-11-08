/** H4: optional rich tool results. Runtimes may return
 *  {"$hosted":"tool-result", content:[{type:"text",text}|{type:"image",data,mimeType}], details}.
 *  Anything else keeps the historical JSON-text conversion. Images are bounded and type-checked. */
export const MAX_RESULT_IMAGES = 4;
export const MAX_RESULT_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_TEXT = 256 * 1024;
type Block = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
const SIGNATURES: Record<string, (b: Buffer) => boolean> = {
  "image/png": b => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/jpeg": b => b[0] === 0xff && b[1] === 0xd8,
  "image/webp": b => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
};
export function toToolResult(value: unknown): { content: Block[]; details: unknown } {
  const v = value as { $hosted?: unknown; content?: unknown; details?: unknown } | null;
  if (!v || typeof v !== "object" || v.$hosted !== "tool-result" || !Array.isArray(v.content)) return { content: [{ type: "text", text: JSON.stringify(value) ?? "null" }], details: value };
  const content: Block[] = []; let images = 0;
  for (const item of v.content.slice(0, 16)) {
    const block = item as Partial<Block> | null;
    if (block?.type === "text" && typeof block.text === "string") content.push({ type: "text", text: block.text.slice(0, MAX_TEXT) });
    else if (block?.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string" && SIGNATURES[block.mimeType] && images < MAX_RESULT_IMAGES) {
      const bytes = /^[A-Za-z0-9+/]*={0,2}$/.test(block.data) ? Buffer.from(block.data, "base64") : null;
      if (bytes && bytes.length <= MAX_RESULT_IMAGE_BYTES && SIGNATURES[block.mimeType]!(bytes)) { content.push({ type: "image", data: block.data, mimeType: block.mimeType }); images++; }
      else content.push({ type: "text", text: "[image omitted by host: invalid or too large]" });
    }
  }
  if (!content.some(b => b.type === "text")) content.unshift({ type: "text", text: "(no text)" });
  return { content, details: v.details ?? null };
}
