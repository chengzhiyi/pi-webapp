import { readFile, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, parse, resolve, sep, delimiter } from "node:path";
import { DefaultPackageManager, getAgentDir, SettingsManager, type ResolvedResource } from "@earendil-works/pi-coding-agent";
import { isPiWebManifest, type PiWebManifest } from "@chengzhiyi/pi-web-protocol";

export interface WebPluginView { id: string; client: string; style?: string }
export interface WebPluginCatalogView { plugins: WebPluginView[]; errors: string[] }
interface PluginRecord { id: string; root: string; manifest: PiWebManifest; clientPath: string; stylePath?: string; revision: string; clientBytes: Buffer; styleBytes?: Buffer }

async function assetContents(clientPath: string, stylePath?: string) {
  const clientBytes = await readFile(clientPath);
  const styleBytes = stylePath ? await readFile(stylePath) : undefined;
  if (clientBytes.length > 8 * 1024 * 1024 || (styleBytes?.length ?? 0) > 8 * 1024 * 1024) throw new Error("Plugin asset exceeds 8 MB");
  const revision = createHash("sha256").update(clientBytes).update("\0").update(styleBytes ?? "").digest("hex");
  return { clientBytes, styleBytes, revision };
}

export function pluginDevRoots(): string[] {
  return (process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS ?? "").split(delimiter).filter(Boolean).map((item) => resolve(item));
}

async function packageRootFor(extensionPath: string): Promise<string | null> {
  let directory = dirname(extensionPath);
  while (directory !== parse(directory).root) {
    try { await stat(join(directory, "package.json")); return directory; }
    catch { directory = dirname(directory); }
  }
  return null;
}

async function assetPath(root: string, relative: string): Promise<string> {
  const absolute = await realpath(join(root, relative));
  if (!absolute.startsWith(root + sep)) throw new Error("Asset escapes package root");
  const details = await stat(absolute);
  if (!details.isFile() || details.size > 8 * 1024 * 1024) throw new Error("Plugin asset is not a regular file under 8 MB");
  return absolute;
}

export class WebPluginCatalog {
  readonly plugins: PluginRecord[];
  readonly errors: string[];
  readonly extensionRoots: string[];
  private constructor(plugins: PluginRecord[], errors: string[], extensionRoots: string[]) {
    this.plugins = plugins;
    this.errors = errors;
    this.extensionRoots = extensionRoots;
  }

  static async discover(cwd: string, projectTrusted: boolean, devRoots = pluginDevRoots()): Promise<WebPluginCatalog> {
    const settings = SettingsManager.create(cwd, undefined, { projectTrusted });
    const manager = new DefaultPackageManager({ cwd, agentDir: getAgentDir(), settingsManager: settings });
    const resolved = await manager.resolve(async () => "skip");
    const dev = devRoots.length ? await manager.resolveExtensionSources(devRoots, { temporary: true }) : { extensions: [] as ResolvedResource[] };
    const roots = new Set<string>();
    for (const item of [...resolved.extensions, ...dev.extensions]) {
      if (!item.enabled) continue;
      const root = await packageRootFor(item.path);
      if (root) roots.add(root);
    }
    for (const root of devRoots) if (isAbsolute(root)) roots.add(root);
    const plugins: PluginRecord[] = [];
    const errors: string[] = [];
    const extensionRoots: string[] = [];
    const names = new Set<string>();
    for (const candidate of roots) {
      try {
        const root = await realpath(candidate);
        const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { name?: unknown; piWebapp?: unknown };
        if (pkg.piWebapp === undefined) continue;
        if (typeof pkg.name !== "string" || !pkg.name) throw new Error("Missing package name");
        if (!isPiWebManifest(pkg.piWebapp)) throw new Error("Unsupported piWebapp manifest or asset path");
        if (names.has(pkg.name)) throw new Error(`Duplicate plugin id: ${pkg.name}`);
        const clientPath = await assetPath(root, pkg.piWebapp.client);
        const stylePath = pkg.piWebapp.style ? await assetPath(root, pkg.piWebapp.style) : undefined;
        names.add(pkg.name);
        plugins.push({ id: pkg.name, root, manifest: pkg.piWebapp, clientPath, stylePath, ...await assetContents(clientPath, stylePath) });
        extensionRoots.push(root);
      } catch (cause) {
        errors.push(`${candidate}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
    plugins.sort((a, b) => a.id.localeCompare(b.id));
    return new WebPluginCatalog(plugins, errors, extensionRoots);
  }

  has(id: string): boolean { return this.plugins.some((item) => item.id === id); }
  ids(): string[] { return this.plugins.map((item) => item.id); }
  async refreshAssets(): Promise<void> {
    for (const plugin of this.plugins) Object.assign(plugin, await assetContents(plugin.clientPath, plugin.stylePath));
  }
  view(): WebPluginCatalogView {
    return {
      plugins: this.plugins.map((item) => ({
        id: item.id,
        client: `/plugins/${encodeURIComponent(item.id)}/client.js?v=${item.revision}`,
        ...(item.stylePath ? { style: `/plugins/${encodeURIComponent(item.id)}/client.css?v=${item.revision}` } : {}),
      })),
      errors: this.errors,
    };
  }
  async asset(urlPath: string): Promise<{ bytes: Buffer; type: string } | null> {
    const url = new URL(urlPath, "http://localhost");
    const match = /^\/plugins\/([^/]+)\/(client\.js|client\.css)$/.exec(url.pathname);
    if (!match) return null;
    let id: string;
    try { id = decodeURIComponent(match[1]!); } catch { return null; }
    const item = this.plugins.find((plugin) => plugin.id === id);
    if (!item || (url.searchParams.has("v") && url.searchParams.get("v") !== item.revision)) return null;
    const bytes = match[2] === "client.js" ? item.clientBytes : item.styleBytes;
    if (!bytes) return null;
    return { bytes, type: match[2] === "client.js" ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8" };
  }
}
