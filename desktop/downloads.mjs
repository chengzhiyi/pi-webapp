import { join } from "node:path";
import { sameDocument } from "./backend.mjs";

/** Only local drawing-export blobs from the app's current trusted document may download.
 * The native save dialog remains the user's destination/overwrite consent boundary.
 * This adds no renderer IPC, filesystem API, remote download or navigation permission.
 */
export function configureLocalExport(event, item, contents, { expectedContents, backendUrl, downloadsPath }) {
  const deny = () => { event.preventDefault(); return false; };
  try {
    if (!backendUrl || !expectedContents || contents !== expectedContents || contents.isDestroyed() || !sameDocument(contents.getURL(), backendUrl)) return deny();
    const url = item.getURL(), chain = item.getURLChain();
    if (!url.startsWith("blob:") || !chain.length || chain.some(value => value !== url)) return deny();
    const blob = new URL(url.slice(5)), backend = new URL(backendUrl);
    if (blob.origin !== backend.origin || blob.username || blob.password || blob.search || blob.hash || !/^\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(blob.pathname)) return deny();
    const name = item.getFilename(), match = /\.([a-z]+)$/i.exec(name);
    if (!name || name.length > 200 || /[\\/\u0000-\u001f\u007f]/.test(name) || !match) return deny();
    const extension = match[1].toLowerCase(), mime = item.getMimeType().toLowerCase();
    const allowed = { png: ["image/png"], svg: ["image/svg+xml"], excalidraw: ["application/json"], json: ["application/json"] };
    if (!allowed[extension]?.includes(mime)) return deny();
    item.setSaveDialogOptions({ title: "导出图稿", defaultPath: join(downloadsPath, name), filters: [{ name: "Drawing export", extensions: [extension] }], properties: ["showOverwriteConfirmation", "createDirectory"] });
    return true;
  } catch { return deny(); }
}
