import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { sentryVitePlugin } from "@sentry/vite-plugin";
// @ts-ignore Build-only JavaScript helper; not included in either runtime bundle.
import { buildInfo, sentryBuildOptions, prepareSourceMaps } from "./scripts/build-config.mjs";

const src = fileURLToPath(new URL("./web/src/", import.meta.url));
const output = fileURLToPath(new URL("./web/dist", import.meta.url));

export default defineConfig(async () => {
  const info = await buildInfo();
  return {
    root: src,
    base: "/",
    esbuild: { jsx: "automatic" },
    define: { __PI_WEB_RELEASE__: JSON.stringify(info.release), __PI_WEB_BUILD_ID__: JSON.stringify(info.buildId) },
    plugins: [
      sentryVitePlugin(sentryBuildOptions("browser", info, output)),
      { name: "pi-web-sentry-final-maps", writeBundle: { order: "pre", sequential: true, handler: () => prepareSourceMaps(output, true) } },
    ],
    build: {
      outDir: "../dist",
      emptyOutDir: true,
      cssCodeSplit: false,
      manifest: true,
      sourcemap: "hidden",
      rollupOptions: {
        output: {
          entryFileNames: "assets/app.js",
          chunkFileNames: "assets/[name]-[hash].js",
          assetFileNames: "assets/[name][extname]",
        },
      },
    },
  };
});
