/** Render-frame exports become top-document downloads. Firefox otherwise treats a
 * blob link in an iframe as a frame navigation blocked by the parent's CSP.
 * No remote URL, filesystem path, renderer IPC, or CSP relaxation is accepted.
 */
export function drawingDownload(input: unknown): { blob: Blob; name: string } {
  const value = input as { blob?: unknown; name?: unknown } | null;
  if (!value || !(value.blob instanceof Blob) || !value.blob.size || value.blob.size > 16 * 1024 * 1024
    || typeof value.name !== "string" || value.name.length > 200 || /[/\\\x00-\x1f\x7f]/.test(value.name)) throw new Error("Invalid drawing download");
  const extension = value.name.split(".").pop()?.toLowerCase();
  const mime = { png: "image/png", svg: "image/svg+xml", excalidraw: "application/json", json: "application/json" }[extension ?? ""];
  if (!mime || value.blob.type !== mime) throw new Error("Unsupported drawing download");
  return { blob: value.blob, name: value.name };
}
export function downloadDrawing(input: unknown) {
  const { blob, name } = drawingDownload(input);
  const url = URL.createObjectURL(blob), anchor = document.createElement("a");
  anchor.href = url; anchor.download = name; anchor.hidden = true;
  document.body.append(anchor);
  try { anchor.click(); } finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 30_000); }
}
