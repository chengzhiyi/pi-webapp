import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

async function files(root, prefix = "") {
  const output = [];
  for (const item of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isSymbolicLink()) throw new Error("Release artifacts must not contain symlinks");
    if (item.isDirectory()) output.push(...await files(root, path));
    else if (item.isFile()) output.push(path);
  }
  return output.sort();
}
export const sha256 = data => createHash("sha256").update(data).digest("hex");

export async function verifyPackageArtifacts(packageRoot, archiveRoot) {
  const info = JSON.parse(await readFile(join(archiveRoot, "build-info.json"), "utf8"));
  if (typeof info.buildId !== "string" || !/^[\w-]{1,80}$/.test(info.buildId) || typeof info.release !== "string" || !info.release.startsWith("pi-webapp@") || !info.release.endsWith(`+${info.buildId}`)) throw new Error("Invalid archived release identity");
  for (const file of await files(packageRoot)) {
    if (file.endsWith(".map") || file.split("/").includes(".sentry-artifacts")) throw new Error("Private source maps leaked into the npm package");
  }
  const output = { release: info.release, buildId: info.buildId, nodeDebugIds: [], browserDebugIds: [] };
  for (const [side, publicPath] of [["node", "dist"], ["browser", "web/dist"]]) {
    const archived = (await files(join(archiveRoot, side))).filter(file => !file.endsWith(".map"));
    const packaged = await files(join(packageRoot, publicPath));
    if (JSON.stringify(archived) !== JSON.stringify(packaged)) throw new Error(`${side}: package assets differ from uploaded assets`);
    let identityFound = false;
    for (const file of archived) {
      const original = await readFile(join(archiveRoot, side, file));
      const shipped = await readFile(join(packageRoot, publicPath, file));
      if (sha256(original) !== sha256(shipped)) throw new Error(`${side}: packaged asset changed after upload`);
      if (!file.endsWith(".js")) continue;
      const code = shipped.toString("utf8");
      const id = code.match(/sentry-dbid-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i)?.[1];
      if (!id) throw new Error(`${side}: packaged JavaScript has no Debug ID`);
      const map = JSON.parse(await readFile(join(archiveRoot, side, `${file}.map`), "utf8"));
      if (map.debug_id !== id || map.debugId !== id || map.version !== 3) throw new Error(`${side}: source map Debug ID mismatch`);
      output[`${side}DebugIds`].push(id);
      if (code.includes(JSON.stringify(info.release)) && code.includes(JSON.stringify(info.buildId))) identityFound = true;
    }
    if (!identityFound || output[`${side}DebugIds`].length === 0) throw new Error(`${side}: JavaScript lacks the archived release/build identity`);
    output[`${side}DebugIds`].sort();
  }
  return output;
}

/** Validate symbolicated application frames; third-party dependency frames need no private maps. */
export function releaseProbeLocation(map, side) {
  const filename = side === "node" ? "extension/sentry-verification.ts" : "web/src/telemetry.ts";
  const marker = `new Error("Sentry ${side === "node" ? "Node" : "browser"} release verification")`;
  const index = map.sources?.findIndex(source => source.replace(/\\/g, "/").endsWith(filename)) ?? -1;
  const source = map.sourcesContent?.[index];
  const lineno = typeof source === "string" ? source.split("\n").findIndex(line => line.includes(marker)) + 1 : 0;
  if (!lineno) throw new Error(`${side}: archived map lacks the verification source location`);
  return { filename, lineno };
}

export function verifyResolvedEvent(event, expected, side, probeLocation) {
  const tags = Array.isArray(event.tags) ? Object.fromEntries(event.tags) : event.tags ?? {};
  if (event.release !== expected.release || event.dist !== expected.buildId || event.environment !== "sentry-verification" || tags.side !== side) throw new Error(`${side}: verification event identity mismatch`);
  const ids = new Set(expected[`${side}DebugIds`]);
  const ownBundle = file => typeof file === "string" && (side === "node" ? /(?:^|\/)dist\/extension\.js$/.test(file) : /(?:^|\/)assets\/[^/]+\.js$/.test(file));
  const images = event.debug_meta?.images ?? [];
  if (!images.some(image => ownBundle(image.code_file) && ids.has(image.debug_id))) throw new Error(`${side}: verification event has no matching application Debug ID`);
  let resolved = 0;
  let probeResolved = false;
  for (const value of event.exception?.values ?? []) {
    const frames = value.stacktrace?.frames ?? [];
    const raw = value.raw_stacktrace?.frames ?? [];
    for (let index = 0; index < raw.length; index++) {
      const original = raw[index];
      if (!ownBundle(original.filename ?? original.abs_path)) continue;
      const frame = frames[index];
      if (!frame || !/(?:^|\/)(?:extension|shared|web\/src)\/.*\.tsx?$/.test(frame.filename ?? frame.abs_path ?? "") || !Number.isInteger(frame.lineno) || frame.lineno <= 0 || frame.data?.symbolicated === false) throw new Error(`${side}: application source frame was not resolved`);
      if (probeLocation && (frame.filename ?? frame.abs_path).endsWith(probeLocation.filename) && frame.lineno === probeLocation.lineno) probeResolved = true;
      resolved++;
    }
  }
  if (!resolved) throw new Error(`${side}: event contains no verified application source frame`);
  if (probeLocation && !probeResolved) throw new Error(`${side}: verification exception resolved to the wrong source file or line`);
}
