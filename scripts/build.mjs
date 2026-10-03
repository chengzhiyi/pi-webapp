import { build as viteBuild } from "vite";
import { build as esbuild } from "esbuild";
import { sentryEsbuildPlugin } from "@sentry/esbuild-plugin";
import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { root, buildInfo, sentryBuildOptions, prepareSourceMaps } from "./build-config.mjs";

const side = process.argv[2] ?? "all";
if (!["all", "browser", "node"].includes(side)) throw new Error("Unknown build target");
if (process.argv.includes("--sentry")) process.env.PI_WEB_SENTRY_UPLOAD = "true";
const info = await buildInfo();
// Validate both destinations before writing build output in the release command.
if (process.env.PI_WEB_SENTRY_UPLOAD === "true") {
  sentryBuildOptions("browser", info, "web/dist");
  sentryBuildOptions("node", info, "dist");
}
const archive = resolve(root, ".sentry-artifacts", info.buildId);
async function stripMaps(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await stripMaps(path);
    else if (entry.name.endsWith(".map")) await rm(path);
  }
}
async function preserveAndStrip(output, name) {
  await prepareSourceMaps(output);
  await mkdir(archive, { recursive: true });
  await cp(output, resolve(archive, name), { recursive: true });
  await writeFile(resolve(archive, "build-info.json"), JSON.stringify(info, null, 2));
  await stripMaps(output);
}

if (side !== "node") {
  try { await viteBuild(); await preserveAndStrip(resolve(root, "web/dist"), "browser"); }
  finally { await stripMaps(resolve(root, "web/dist")).catch(() => {}); }
}
if (side !== "browser") {
  try {
    await esbuild({
      entryPoints: [resolve(root, "extension/index.ts")], bundle: true, platform: "node", format: "esm", target: "node22", packages: "external", minify: true,
      outfile: resolve(root, "dist/extension.js"), sourcemap: "external",
      define: { __PI_WEB_RELEASE__: JSON.stringify(info.release), __PI_WEB_BUILD_ID__: JSON.stringify(info.buildId) },
      plugins: [{ name: "bundle-local-protocol", setup(builder) {
        builder.onResolve({ filter: /^@chengzhiyi\/pi-web-protocol$/ }, () => ({ path: fileURLToPath(import.meta.resolve("@chengzhiyi/pi-web-protocol")) }));
      } }, sentryEsbuildPlugin(sentryBuildOptions("node", info, resolve(root, "dist")))],
    });
    await preserveAndStrip(resolve(root, "dist"), "node");
  } finally { await stripMaps(resolve(root, "dist")).catch(() => {}); }
}
console.log(`Built ${info.release}; private source maps: .sentry-artifacts/${info.buildId}`);
