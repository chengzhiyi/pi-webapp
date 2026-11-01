import { lstat, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { HostedPluginError } from "./errors.ts";
import { RESOURCE_LIMITS, regularFile, sha256 } from "./resources.ts";

/** Copy a developer's package directory (package.json + dist/ only) into `staging`.
 * Source-tree extras (src/, node_modules, tsconfig...) are never copied. Links and special files are refused, so what is
 * staged can be validated by the same `validateHostedPackage` that checks registry archives.
 * `contentHash` ignores the version field: it identifies the code, while the installer assigns the version. */
export async function snapshotDevPackage(directory: string, staging: string): Promise<{ contentHash: string; packageJson: Record<string, unknown> }> {
  const root = await realpath(directory);
  const raw = await regularFile(root, "package.json", RESOURCE_LIMITS.other);
  let packageJson: Record<string, unknown>;
  try { packageJson = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as Record<string, unknown>; } catch { throw new HostedPluginError("invalid_package", "package.json is not valid JSON"); }
  if (!packageJson || typeof packageJson !== "object" || Array.isArray(packageJson)) throw new HostedPluginError("invalid_package", "package.json must be an object");
  const files: Array<[string, string]> = [];
  let count = 0, total = 0;
  async function walk(relative: string, depth: number): Promise<void> {
    if (depth > 16) throw new HostedPluginError("invalid_package", "Package directory nesting limit exceeded");
    for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (++count > RESOURCE_LIMITS.files) throw new HostedPluginError("invalid_package", "Too many package entries");
      if (entry.isDirectory()) { await walk(child, depth + 1); continue; }
      if (!entry.isFile()) throw new HostedPluginError("invalid_package", `Links and non-regular files are forbidden: ${child}`);
      const bytes = await regularFile(root, child, RESOURCE_LIMITS.js);
      if ((total += bytes.length) > RESOURCE_LIMITS.total) throw new HostedPluginError("invalid_package", "Resource budget exceeded");
      const target = join(staging, child);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
      files.push([child, sha256(bytes)]);
    }
  }
  let info;
  try { info = await lstat(join(root, "dist")); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new HostedPluginError("dist_missing", "dist/ does not exist yet; build the plugin first");
    throw error;
  }
  if (!info.isDirectory()) throw new HostedPluginError("invalid_package", "dist must be a real directory");
  await walk("dist", 0);
  const { version: _version, ...identity } = packageJson;
  files.sort((a, b) => a[0].localeCompare(b[0]));
  return { contentHash: sha256(JSON.stringify({ package: identity, files })), packageJson };
}
