import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
/** Explicit asset inventory, not a public directory or arbitrary plugin-directory serving. */
export function excalidrawAssets() {
  return {
    name: "pi-diagram-local-fonts",
    enforce: "pre",
    transform(code, id) {
      if (!id.includes("/@excalidraw/excalidraw/dist/prod/") || !code.includes("ASSETS_FALLBACK_URL")) return;
      // The pinned component always appends a CDN fallback, even with a local asset path.
      // Keep font source lists strictly local (also avoids CSP reports for unused CDN sources).
      const pattern = /return (\w+)\.push\(new URL\((\w+),\w+\.ASSETS_FALLBACK_URL\)\),\1/g;
      if ([...code.matchAll(pattern)].length !== 1) throw new Error("Review Excalidraw font fallback patch before upgrading the pinned editor");
      return { code: code.replace(pattern, "return $1"), map: null };
    },
    async generateBundle() {
      const root = fileURLToPath(new URL("../node_modules/@excalidraw/excalidraw/dist/prod/fonts/", import.meta.url));
      const assets = [];
      const visit = async (directory, prefix = "") => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const name = `${prefix}${entry.name}`;
          if (entry.isDirectory()) await visit(join(directory, entry.name), `${name}/`);
          else if (/^[\w/.-]+\.woff2$/.test(name)) {
            const fileName = `assets/excalidraw/fonts/${name}`;
            this.emitFile({ type: "asset", fileName, source: await readFile(join(directory, entry.name)) }); assets.push(fileName);
          }
        }
      };
      await visit(root);
      this.emitFile({ type: "asset", fileName: ".vite/static-assets.json", source: JSON.stringify(assets) });
    },
  };
}
