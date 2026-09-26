import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const src = fileURLToPath(new URL("./web/src/", import.meta.url));

export default defineConfig({
  root: src,
  base: "/",
  esbuild: { jsx: "automatic" },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        entryFileNames: "assets/app.js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
