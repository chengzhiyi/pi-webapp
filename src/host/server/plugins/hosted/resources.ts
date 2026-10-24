import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, relative, resolve, sep } from "node:path";
import { hostedAssetPath, isHostedPluginManifest, type HostedPluginManifest, type HostedResource, type HostedResourceManifest } from "@chengzhiyi/pi-web-protocol";
import { HostedPluginError } from "./errors.ts";

export const RESOURCE_LIMITS = { files: 4096, total: 128 * 1024 * 1024, js: 16 * 1024 * 1024, css: 4 * 1024 * 1024, font: 8 * 1024 * 1024, other: 2 * 1024 * 1024 } as const;
const mimeByExtension: Record<string, string[]> = {
  js: ["text/javascript", "application/javascript"], mjs: ["text/javascript", "application/javascript"], css: ["text/css"],
  html: ["text/html"], json: ["application/json"], woff2: ["font/woff2"], woff: ["font/woff"],
  png: ["image/png"], svg: ["image/svg+xml"], txt: ["text/plain"],
};
export interface HostedPackage {
  id: string;
  version: string;
  root: string;
  manifest: HostedPluginManifest;
  resources: ReadonlyMap<string, HostedResource>;
  digest: string;
}
export const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
function reject(message: string): never { throw new HostedPluginError("invalid_package", message); }
export async function regularFile(root: string, path: string, maxBytes: number): Promise<Buffer> {
  const parts = path.split("/");
  if (!parts.length || parts.some(p => !p || p === "." || p === ".." || !/^[\w.-]+$/.test(p))) reject("Invalid resource path");
  let target = root;
  for (let i = 0; i < parts.length; i++) {
    target = join(target, parts[i]!);
    const info = await lstat(target);
    if (info.isSymbolicLink() || (i < parts.length - 1 ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)) reject("Links and non-regular package files are forbidden");
  }
  const canonical = await realpath(target);
  if (canonical !== resolve(root, path) || relative(root, canonical).startsWith(`..${sep}`)) reject("Resource escapes package root");
  const file = await open(target, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > maxBytes) reject("Oversized or non-regular package file");
    // Bound actual reads as well as the stat; a concurrently growing file must not allocate without limit.
    const bytes = Buffer.alloc(Math.min(info.size + 1, maxBytes + 1));
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > maxBytes || length !== info.size) reject("Package resource changed during read");
    return bytes.subarray(0, length);
  } finally { await file.close(); }
}
function json(bytes: Buffer): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return reject("Invalid package JSON"); }
}
/** Validate a prebuilt package in a private staging directory before any of its code executes. */
export async function validateHostedPackage(directory: string, expectedId?: string): Promise<HostedPackage> {
  const root = await realpath(directory);
  if ((await lstat(directory)).isSymbolicLink()) reject("Package root cannot be a symlink");
  const pkg = json(await regularFile(root, "package.json", RESOURCE_LIMITS.other)) as Record<string, unknown> | null;
  if (!pkg || typeof pkg.name !== "string" || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(pkg.name) || pkg.name.length > 214 || expectedId && pkg.name !== expectedId) reject("Package identity mismatch");
  if (typeof pkg.version !== "string" || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(pkg.version)) reject("Invalid package version");
  if (!isHostedPluginManifest(pkg.piWebapp)) reject("Unsupported hosted manifest");
  if (pkg.type !== "module") reject("Hosted package must declare ESM module type");
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === "dist" && entry.isDirectory()) continue;
    if (!entry.isFile() || !["package.json", "README.md", "LICENSE", "NOTICE.txt"].includes(entry.name)) reject("Undeclared package-root asset or code");
  }
  if (pkg.scripts && Object.keys(pkg.scripts as object).some(key => /^(?:preinstall|install|postinstall|prepare)$/.test(key))) reject("Hosted packages cannot run install lifecycle scripts");
  // First-party v2 artifacts must be self-contained. No ambient node_modules/native build fallback.
  for (const key of ["dependencies", "optionalDependencies"]) {
    const dependencies = pkg[key];
    if (dependencies && (typeof dependencies !== "object" || Object.keys(dependencies).length > 0)) reject("Hosted packages must contain all runtime dependencies");
  }
  const manifest = pkg.piWebapp;
  const raw = json(await regularFile(root, manifest.resourcesManifest.slice(2), RESOURCE_LIMITS.other)) as Partial<HostedResourceManifest> | null;
  if (!raw || raw.version !== 1 || !Array.isArray(raw.files) || !raw.files.length || raw.files.length > RESOURCE_LIMITS.files) reject("Invalid resource manifest");
  const resources = new Map<string, HostedResource>();
  let total = 0;
  for (const value of raw.files) {
    if (!value || typeof value !== "object") reject("Invalid resource entry");
    // Public manifests may spell a package-relative path with './'; normalize once and reject
    // aliases/duplicates before using it as an inventory key or filesystem path.
    const rawItem = value as HostedResource;
    const item = { ...rawItem, path: typeof rawItem.path === "string" && rawItem.path.startsWith("./") ? rawItem.path.slice(2) : rawItem.path };
    if (!hostedAssetPath(`./${item.path}`) || typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256)
      || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || resources.has(item.path)) reject("Invalid or duplicate resource");
    const ext = item.path.split(".").at(-1)!;
    if (!mimeByExtension[ext]?.includes(item.mime)) reject("Unsupported resource MIME");
    const limit = ext === "js" || ext === "mjs" ? RESOURCE_LIMITS.js : ext === "css" ? RESOURCE_LIMITS.css : ext === "woff" || ext === "woff2" ? RESOURCE_LIMITS.font : RESOURCE_LIMITS.other;
    if (item.bytes > limit || (total += item.bytes) > RESOURCE_LIMITS.total) reject("Resource budget exceeded");
    const bytes = await regularFile(root, item.path, limit);
    if (bytes.length !== item.bytes || sha256(bytes) !== item.sha256) reject("Resource integrity mismatch");
    resources.set(item.path, Object.freeze({ ...item }));
  }
  for (const path of [manifest.backend.entry, manifest.frontend.document, manifest.frontend.controller]) if (!resources.has(path.slice(2))) reject("Entrypoint is absent from resource manifest");
  // No undeclared code/assets under dist. Readme/LICENSE files outside dist are not served.
  let members = 0;
  async function walk(path: string, depth = 0): Promise<void> {
    if (depth > 16) reject("Package directory nesting limit exceeded");
    for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
      if (++members > RESOURCE_LIMITS.files * 2) reject("Too many package entries");
      const child = `${path}/${entry.name}`;
      if (entry.isSymbolicLink() || !entry.isDirectory() && !entry.isFile()) reject("Invalid archive member");
      if (entry.isDirectory()) await walk(child, depth + 1);
      else if (child !== manifest.resourcesManifest.slice(2) && !resources.has(child)) reject("Undeclared distribution asset");
    }
  }
  await walk("dist");
  const digest = sha256(JSON.stringify({ id: pkg.name, version: pkg.version, manifest, resources: [...resources.values()].sort((a, b) => a.path.localeCompare(b.path)) }));
  return { id: pkg.name, version: pkg.version, root, manifest, resources, digest };
}
/** Immutable URLs include package digest. Recheck bytes so modified installed files are never executed. */
export async function hostedAsset(pkg: HostedPackage, encodedPath: string, digest: string): Promise<{ bytes: Buffer; mime: string } | null> {
  if (digest !== pkg.digest || encodedPath.length > 1536) return null;
  let path: string;
  try { path = decodeURIComponent(encodedPath); } catch { return null; }
  if (!hostedAssetPath(`./${path}`)) return null;
  const item = pkg.resources.get(path);
  // Backend entries are verified but never served to the browser.
  if (!item || path === pkg.manifest.backend.entry.slice(2)) return null;
  const bytes = await regularFile(pkg.root, path, item.bytes);
  if (bytes.length !== item.bytes || sha256(bytes) !== item.sha256) throw new HostedPluginError("resource_changed", "Installed resource integrity mismatch");
  return { bytes, mime: item.mime };
}
