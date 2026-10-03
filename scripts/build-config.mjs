import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../", import.meta.url));

// Vite can regenerate an entry map after Sentry's generateBundle hook. Run this
// on the final files, before Sentry's writeBundle upload hook, then verify again
// before archiving. Never inject a new ID: it must match the shipped JS.
export async function prepareSourceMaps(directory, repairMissing = false) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = resolve(directory, entry.name);
    if (entry.isDirectory()) { await prepareSourceMaps(file, repairMissing); continue; }
    if (!entry.name.endsWith(".js.map")) continue;
    const code = await readFile(file.slice(0, -4), "utf8");
    const id = code.match(/sentry-dbid-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i)?.[1];
    const map = JSON.parse(await readFile(file, "utf8"));
    let changed = false;
    // Vite's ../../src paths would resolve as /src in Sentry. Give owned
    // sources stable repository paths before its upload hook runs.
    if (repairMissing && Array.isArray(map.sources)) {
      map.sources = map.sources.map(source => {
        if (typeof source !== "string" || /^[a-z]+:/i.test(source)) return source;
        const owned = relative(root, resolve(dirname(file), map.sourceRoot || "", source)).replace(/\\/g, "/");
        if (!/^(?:web\/src|shared|extension)\//.test(owned)) return source;
        changed = true;
        return `app:///${owned}`;
      });
    }
    if (!id || [map.debug_id, map.debugId].some((value) => value && value !== id)) throw new Error(`Invalid Sentry Debug ID for ${entry.name}`);
    if (map.debug_id !== id || map.debugId !== id) {
      if (!repairMissing) throw new Error(`Missing Sentry Debug ID for ${entry.name}`);
      map.debug_id = map.debugId = id;
      changed = true;
    }
    if (changed) await writeFile(file, JSON.stringify(map));
  }
}
export async function buildInfo() {
  const hash = createHash("sha256");
  async function visit(path) {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = resolve(path, entry.name);
      if (entry.isDirectory()) await visit(file);
      else { hash.update(relative(root, file)); hash.update(await readFile(file)); }
    }
  }
  for (const folder of ["extension", "shared", "web/src", "scripts"]) await visit(resolve(root, folder));
  for (const name of ["package.json", "package-lock.json", "vite.config.ts"]) hash.update(await readFile(resolve(root, name)));
  const { version } = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const buildId = hash.digest("hex").slice(0, 20);
  return { buildId, release: `pi-webapp@${version}+${buildId}` };
}

export function sentryBuildOptions(side, info, output) {
  const upload = process.env.PI_WEB_SENTRY_UPLOAD === "true";
  const project = process.env[`SENTRY_${side.toUpperCase()}_PROJECT`] || process.env.SENTRY_PROJECT;
  if (upload && (!process.env.SENTRY_AUTH_TOKEN || !process.env.SENTRY_ORG || !project)) throw new Error(`Sentry ${side} upload requires SENTRY_AUTH_TOKEN, SENTRY_ORG and SENTRY_PROJECT (or per-side project).`);
  return {
    telemetry: false, silent: !upload,
    ...(upload ? { authToken: process.env.SENTRY_AUTH_TOKEN, org: process.env.SENTRY_ORG, project, ...(process.env.SENTRY_URL ? { url: process.env.SENTRY_URL } : {}) } : {}),
    release: { name: info.release, dist: info.buildId, inject: false, create: upload, finalize: upload },
    sourcemaps: { disable: upload ? false : "disable-upload", assets: [`${output}/**/*.js`, `${output}/**/*.map`] },
    errorHandler: (error) => { throw error; },
  };
}
