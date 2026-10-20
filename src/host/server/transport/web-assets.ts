import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Only build-manifest entries are served; maps, traversal and arbitrary files remain inaccessible. */
export async function readAssetManifest(root: string): Promise<Record<string, { path: string; type: string }>> {
  try {
    const manifest: unknown = JSON.parse(await readFile(join(root, ".vite/manifest.json"), "utf8"));
    if (!manifest || typeof manifest !== "object") return {};
    const files = new Set<string>();
    for (const entry of Object.values(manifest)) {
      if (!entry || typeof entry !== "object") continue;
      for (const value of [entry.file, ...(Array.isArray(entry.css) ? entry.css : []), ...(Array.isArray(entry.assets) ? entry.assets : [])]) {
        if (typeof value === "string" && /^assets\/[\w.-]+\.(?:js|css|woff2?|ttf|png|jpe?g|svg|webp)$/.test(value)) files.add(value);
      }
    }
    const types: Record<string, string> = { js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf" };
    return Object.fromEntries([...files].map((path) => [`/${path}`, { path, type: types[path.split(".").pop()!]! }]));
  } catch { return {}; } // Tests and old builds may not have a manifest.
}
