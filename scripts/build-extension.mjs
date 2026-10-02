import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const protocol = fileURLToPath(import.meta.resolve("@chengzhiyi/pi-web-protocol"));
await build({
  entryPoints: ["extension/index.ts"],
  outfile: "dist/extension.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  minify: true,
  plugins: [{
    name: "bundle-local-protocol",
    setup(builder) {
      builder.onResolve({ filter: /^@chengzhiyi\/pi-web-protocol$/ }, () => ({ path: protocol }));
    },
  }],
});
