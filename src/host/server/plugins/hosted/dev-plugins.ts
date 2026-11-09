import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { lstat, readdir, writeFile, mkdir, rename } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { isHostedPluginManifest } from "@chengzhiyi/pi-web-protocol";
import type { HostedDevInfo, HostedPluginCatalog } from "../../../../contracts/hosted-plugins.ts";
import { failure, HostedPluginError } from "./errors.ts";
import { OFFICIAL_PLUGINS, type OfficialPlugin } from "./official-catalog.ts";
import { parseCatalogEntry, type CatalogEntry } from "./catalog-schema.ts";
import type { HostedPluginPolicy } from "./plugin-policies.ts";

export interface DevNotice { level: "error" | "warning" | "info"; pluginId?: string; source: string; message: string }
const official = (id: string) => OFFICIAL_PLUGINS.some(plugin => plugin.id === id);
const officialIds = () => OFFICIAL_PLUGINS.map(plugin => plugin.id).join(", ");
/** The `package.json` key a not-yet-official package uses to describe itself in dev mode. Same shape as an `official-plugins.json` entry,
 * minus what the package already states: `id` is its name, `requiredCapabilities` default to its manifest's, and it has no registry release. */
export const DEV_CATALOG_KEY = "piWebappCatalog";
const NPM_REGISTRY = "https://registry.npmjs.org";

/** A developer's own package description. Trusted only because dev mode is an explicit local opt-in; it never makes the plugin "Official". */
export function devCatalogEntry(pkg: { name: string; piWebapp: { capabilities: readonly string[] }; [DEV_CATALOG_KEY]?: unknown }, where: string): CatalogEntry {
  const block = pkg[DEV_CATALOG_KEY];
  if (block === undefined) throw new HostedPluginError("invalid_catalog", `${where}: ${pkg.name} is not an official plugin (official: ${officialIds()}). Describe it in package.json "${DEV_CATALOG_KEY}" with name, description and policy`);
  if (!block || typeof block !== "object" || Array.isArray(block)) throw new HostedPluginError("invalid_catalog", `${where}: ${DEV_CATALOG_KEY} must be an object`);
  if ("id" in block || "registry" in block) throw new HostedPluginError("invalid_catalog", `${where}: ${DEV_CATALOG_KEY} must not set id or registry; the package name is the id`);
  const entry = parseCatalogEntry({ registry: NPM_REGISTRY, recommendedVersion: "0.0.0", requiredCapabilities: [...pkg.piWebapp.capabilities], ...block, id: pkg.name }, where, DEV_CATALOG_KEY);
  return { ...entry, official: false };
}

/** `PI_WEBAPP_HOSTED_DEV_ARCHIVES="<id>=<path.tgz>;<id>=<path.tgz>"`, for official plugins only; other packages use a dev directory. */
export function devPluginsFromEnv(value = process.env.PI_WEBAPP_HOSTED_DEV_ARCHIVES): { archives: Map<string, string>; notices: DevNotice[] } {
  const archives = new Map<string, string>(), notices: DevNotice[] = [];
  const source = "PI_WEBAPP_HOSTED_DEV_ARCHIVES";
  for (const part of (value ?? "").split(/[;\n]/).map(s => s.trim()).filter(Boolean)) {
    const eq = part.lastIndexOf("="), id = part.slice(0, eq), file = part.slice(eq + 1);
    const problem = eq < 1 ? `entry "${part}" is not <id>=<path.tgz>`
      : !official(id) ? `"${id}" is not an official plugin (official: ${officialIds()}); develop other packages from a directory in PI_WEBAPP_HOSTED_DEV_ROOTS`
      : !file.endsWith(".tgz") ? `"${file}" is not a .tgz archive`
      : !existsSync(resolve(file)) ? `archive not found: ${resolve(file)}` : null;
    if (problem) { notices.push({ level: "error", source, ...(official(id) ? { pluginId: id } : {}), message: problem }); continue; }
    archives.set(id, resolve(file));
  }
  return { archives, notices };
}

/** Where the persistent developer configuration lives. The file is read again on every poll, so a running host picks up edits. */
export const hostedDevConfigPath = (agentDir: string) => join(agentDir, "pi-web", "hosted-dev.json");
export const hostedDevStatusPath = (agentDir: string) => join(agentDir, "pi-web", "hosted-dev-status.json");

interface RootSpec { path: string; source: string }
/** Developer package directories from `PI_WEBAPP_HOSTED_DEV_ROOTS` (path-delimiter separated) and `hosted-dev.json` ({"roots": [absolute paths]}). */
export function readDevRootSpecs(env: NodeJS.ProcessEnv, configPath: string | undefined, cwd = process.cwd()): { specs: RootSpec[]; notices: DevNotice[]; configured: boolean } {
  const specs: RootSpec[] = [], notices: DevNotice[] = [];
  const fromEnv = (env.PI_WEBAPP_HOSTED_DEV_ROOTS ?? "").split(delimiter).map(s => s.trim()).filter(Boolean);
  for (const item of fromEnv) specs.push({ path: resolve(cwd, item), source: "PI_WEBAPP_HOSTED_DEV_ROOTS" });
  let configured = fromEnv.length > 0;
  if (configPath && existsSync(configPath)) {
    configured = true;
    try {
      const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
      const roots = parsed && typeof parsed === "object" ? (parsed as { roots?: unknown }).roots : undefined;
      if (!Array.isArray(roots)) throw new Error('expected {"roots": ["/absolute/package/dir", ...]}');
      for (const item of roots) {
        if (typeof item !== "string" || !isAbsolute(item)) notices.push({ level: "error", source: configPath, message: `root ${JSON.stringify(item)} must be an absolute path string` });
        else specs.push({ path: resolve(item), source: configPath });
      }
    } catch (error) {
      notices.push({ level: "error", source: configPath, message: `cannot read dev configuration: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return { specs, notices, configured };
}
/** Say "parent" only when a subdirectory really is a package; otherwise the folder is usually build output left by another branch. */
function missingPackageJson(dir: string) {
  let children: string[] = [];
  try { children = readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name !== "node_modules" && existsSync(join(dir, entry.name, "package.json"))).map(entry => entry.name); } catch { /* unreadable: fall through to the generic hint */ }
  return children.length
    ? `package.json not found; this looks like a parent folder (packages inside: ${children.slice(0, 3).join(", ")}). Point at the package directory itself`
    : "package.json not found; the folder is not a package (is the right branch checked out?)";
}
/** Identify and sanity-check one developer package directory without running or copying anything. Full validation happens at install. */
export function inspectDevRoot(spec: RootSpec): { pluginId?: string; entry?: CatalogEntry; notice?: DevNotice } {
  const fail = (message: string, pluginId?: string): { notice: DevNotice } => ({ notice: { level: "error", source: spec.source, ...(pluginId ? { pluginId } : {}), message: `${spec.path}: ${message}` } });
  let info;
  try { info = statSync(spec.path); } catch { return fail("directory does not exist"); }
  if (!info.isDirectory()) return fail("not a directory (expected the package directory containing package.json)");
  let pkg: { name?: unknown; piWebapp?: unknown; [DEV_CATALOG_KEY]?: unknown };
  try { pkg = JSON.parse(readFileSync(join(spec.path, "package.json"), "utf8")); }
  catch (error) { return fail((error as NodeJS.ErrnoException).code === "ENOENT" ? missingPackageJson(spec.path) : "package.json is not valid JSON"); }
  if (typeof pkg.name !== "string") return fail("package.json has no name");
  if (!isHostedPluginManifest(pkg.piWebapp)) return fail('package.json "piWebapp" is not a valid hosted v2 manifest (apiVersion, hostRange, backend, frontend, resourcesManifest, capabilities)', pkg.name);
  // An official plugin always runs under its reviewed policy, even from a dev directory, so dev behaves like production.
  if (official(pkg.name)) return { pluginId: pkg.name };
  try { return { pluginId: pkg.name, entry: devCatalogEntry({ name: pkg.name, piWebapp: pkg.piWebapp, [DEV_CATALOG_KEY]: pkg[DEV_CATALOG_KEY] }, "package.json") }; }
  catch (error) { return fail(failure(error).message, pkg.name); }
}

/** Live developer configuration shared with the manager: `roots` is mutated in place when the config file changes. */
export class HostedDevSources {
  /** Self-described (non-official) packages accepted at startup, and their policies. Official plugins are never repeated here. */
  readonly catalog: OfficialPlugin[] = [];
  readonly policies = new Map<string, HostedPluginPolicy>();
  readonly archives: Map<string, string>;
  readonly roots = new Map<string, string>();
  readonly rootSource = new Map<string, string>();
  private fileNotices: DevNotice[];
  private readonly archiveNotices: DevNotice[];
  private rootNotices: DevNotice[] = [];
  private readonly env: NodeJS.ProcessEnv;
  private readonly configPath?: string;
  private readonly cwd: string;
  /** True once any explicit developer opt-in (env or config file) exists. */
  enabled = false;
  constructor(options: { env?: NodeJS.ProcessEnv; configPath?: string; cwd?: string } = {}) {
    this.env = options.env ?? process.env; this.configPath = options.configPath; this.cwd = options.cwd ?? process.cwd();
    const archives = devPluginsFromEnv(this.env.PI_WEBAPP_HOSTED_DEV_ARCHIVES);
    this.archives = archives.archives; this.archiveNotices = archives.notices; this.fileNotices = [];
    this.enabled = !!this.env.PI_WEBAPP_HOSTED_DEV_ARCHIVES;
    const roots = this.refresh(true);
    this.enabled ||= roots.configured;
  }
  /** Re-read env + config file. At startup (`initial`) accepted plugins also join the catalog; later, a plugin that was not in the
   * startup catalog cannot gain a runtime, so it is reported as needing a host restart instead of being silently ignored. */
  refresh(initial = false): { configured: boolean } {
    const read = readDevRootSpecs(this.env, this.configPath, this.cwd);
    const notices: DevNotice[] = [], next = new Map<string, string>(), sources = new Map<string, string>();
    for (const spec of read.specs) {
      const inspected = inspectDevRoot(spec);
      if (inspected.notice) { notices.push(inspected.notice); continue; }
      const id = inspected.pluginId!;
      if (next.has(id)) { notices.push({ level: "error", pluginId: id, source: spec.source, message: `${spec.path}: plugin ${id} is already provided by ${next.get(id)}` }); continue; }
      if (this.archives.has(id)) { notices.push({ level: "warning", pluginId: id, source: spec.source, message: `${spec.path}: PI_WEBAPP_HOSTED_DEV_ARCHIVES also provides ${id}; the dev directory wins` }); }
      if (!official(id) && !this.catalog.some(p => p.id === id)) {
        if (!initial) { notices.push({ level: "warning", pluginId: id, source: spec.source, message: `${spec.path}: ${id} was not part of this host's startup configuration. Restart pi-webapp once (npm run stop && npm run start) to list it.` }); continue; }
        const { policy, ...plugin } = inspected.entry!;
        this.catalog.push(plugin); this.policies.set(id, policy);
      } else if (inspected.entry && JSON.stringify(inspected.entry.policy) !== JSON.stringify(this.policies.get(id))) {
        notices.push({ level: "warning", pluginId: id, source: spec.source, message: `${spec.path}: the ${DEV_CATALOG_KEY} policy changed; restart pi-webapp once (npm run stop && npm run start) to apply it. Code still reloads live.` });
      }
      next.set(id, spec.path); sources.set(id, spec.source);
    }
    for (const id of [...this.roots.keys()]) if (!next.has(id)) this.roots.delete(id);
    for (const [id, path] of next) this.roots.set(id, path);
    this.rootSource.clear(); for (const [id, source] of sources) this.rootSource.set(id, source);
    this.fileNotices = read.notices; this.rootNotices = notices;
    return { configured: read.configured };
  }
  notices(): DevNotice[] { return [...this.archiveNotices, ...this.fileNotices, ...this.rootNotices]; }
}

type RootState = "waiting-build" | "switching" | "synced" | "pending" | "not-installed" | "error";
interface WatchedRoot { seen?: string; applied?: string; retry?: boolean; state: RootState; message?: string; code?: string; version?: string; at: string; root: string }
export interface DevSwitcher {
  /** Install-if-needed is NOT done here: a plugin the user never installed is left alone. */
  update(pluginId: string): Promise<HostedPluginCatalog>;
  /** Apply a build the host parked as pending (the "Apply pending update" path); no reinstall. */
  retry?(pluginId: string): Promise<HostedPluginCatalog>;
}
export interface HostedDevWatcherOptions {
  sources: HostedDevSources;
  switcher: DevSwitcher;
  /** Status file for tooling such as `pnpm dev`. Omit to disable. */
  statusPath?: string;
  pollMs?: number;
  log?: (message: string) => void;
  /** Called after a status change so the page can refresh its notices. */
  changed?: () => void;
}
/** Host-side hot reload: poll developer directories and run the normal, serialized `update` switch when their files settle. */
export class HostedDevWatcher {
  private readonly options: HostedDevWatcherOptions;
  private readonly roots = new Map<string, WatchedRoot>();
  private timer?: ReturnType<typeof setTimeout>;
  private current: Promise<void> = Promise.resolve();
  private running = false;
  private stopped = false;
  private lastStatus = "";
  private lastNotices = "";
  constructor(options: HostedDevWatcherOptions) { this.options = options; }
  start(): void {
    if (this.running) return;
    this.running = true; this.stopped = false;
    for (const notice of this.options.sources.notices()) this.log(`${notice.level}: ${notice.message}`);
    const loop = () => {
      this.current = this.tick().catch(error => { if (this.running) this.log(`poll failed: ${failure(error).message}`); })
        .finally(() => { if (this.running) { this.timer = setTimeout(loop, this.options.pollMs ?? 700); this.timer.unref?.(); } });
    };
    loop();
  }
  stop(): void { this.running = false; this.stopped = true; clearTimeout(this.timer); }
  /** Forget what was last applied for a plugin so the next poll re-evaluates it (cheap when nothing changed). */
  invalidate(id: string): void { const state = this.roots.get(id); if (state) state.applied = undefined; }
  /** Resolves when the poll that was running at stop() has finished (it may still be inside a switch). */
  idle(): Promise<void> { return this.current; }
  info(): HostedDevInfo {
    return {
      notices: this.options.sources.notices().map(n => ({ level: n.level, ...(n.pluginId ? { pluginId: n.pluginId } : {}), message: n.message })),
      sources: [...this.roots].map(([pluginId, r]) => ({ pluginId, root: r.root, state: r.state, ...(r.version ? { version: r.version } : {}), ...(r.message ? { message: r.message } : {}) })),
    };
  }
  private log(message: string) { (this.options.log ?? (m => console.error(`pi-webapp [hosted-dev] ${m}`)))(message); }
  /** One poll. Exposed so tests drive time explicitly. A change is applied once its signature is identical on two consecutive polls. */
  async tick(): Promise<void> {
    this.options.sources.refresh();
    const live = this.options.sources.roots;
    for (const id of [...this.roots.keys()]) if (!live.has(id)) this.roots.delete(id);
    for (const [id, root] of live) {
      let state = this.roots.get(id);
      if (!state || state.root !== root) { state = { root, state: "waiting-build", at: new Date().toISOString() }; this.roots.set(id, state); }
      const signature = await devSignature(root);
      if (signature === null) { this.set(id, state, "waiting-build", { message: "dist/ or package.json is missing; waiting for a build" }); state.seen = undefined; continue; }
      if (signature !== state.seen) { state.seen = signature; continue; }
      if (this.stopped) continue;
      // Dev switches reopen editors, so a parked (pending) build only ever waited on in-flight work, such
      // as an editor mid-save: apply it again on each poll instead of waiting for a click that never comes.
      if (signature === state.applied) { if (state.retry && this.options.switcher.retry) await this.apply(id, state, signature, true); continue; }
      await this.apply(id, state, signature);
    }
    await this.publish();
  }
  private set(id: string, state: WatchedRoot, next: RootState, detail: { message?: string; code?: string; version?: string } = {}) {
    const changed = state.state !== next || state.message !== detail.message || state.version !== detail.version;
    state.state = next; state.message = detail.message; state.code = detail.code; state.version = detail.version ?? state.version;
    if (changed) { state.at = new Date().toISOString(); this.log(`${id}: ${next}${detail.version ? ` ${detail.version}` : ""}${detail.message ? ` — ${detail.message}` : ""}`); }
  }
  private async apply(id: string, state: WatchedRoot, signature: string, retry = false): Promise<void> {
    if (!retry) this.set(id, state, "switching"); // a retry stays "pending" until it lands, without flapping the status
    try {
      const catalog = await (retry ? this.options.switcher.retry!(id) : this.options.switcher.update(id));
      const card = catalog.plugins.find(p => p.pluginId === id);
      state.applied = signature; state.retry = !!card?.installed && !!card.pendingVersion;
      if (!card?.installed) this.set(id, state, "not-installed", { message: "Not installed; install it from the plugin page to start using this source" });
      else if (card.pendingVersion) this.set(id, state, "pending", { version: card.version, message: `Waiting for editors to close before switching to ${card.pendingVersion}` });
      else this.set(id, state, "synced", { version: card.version });
    } catch (error) {
      const detail = failure(error);
      // Busy/shutdown conditions say nothing about the files, so try again; validation failures wait for the next save.
      // An open editor that is mid-save (view_busy) finishes within a request: retry on the next poll, not an error.
      const saving = detail.reason === "view_busy";
      const transient = saving || ["storage_busy", "manager_closed", "download_pending", "plugin_unavailable"].includes(detail.code);
      // A failed retry keeps the parked build as the one to apply while the failure is transient.
      if (retry) { state.applied = signature; state.retry = transient; }
      else if (!transient) state.applied = signature;
      const notInstalled = detail.code === "not_installed";
      if (saving) this.set(id, state, "pending", { message: "An open editor is saving; switching once it finishes" });
      else if (notInstalled) this.set(id, state, "not-installed", { message: "Not installed; install it from the plugin page to start using this source" });
      else this.set(id, state, "error", { code: detail.code, message: `${detail.message} (${detail.code}). Fix and save again.` });
    }
    state.at = new Date().toISOString(); // tooling waits for "an outcome newer than my build", even when the outcome text repeats
  }
  private async publish(): Promise<void> {
    const info = this.info(), notices = JSON.stringify(info);
    if (notices !== this.lastNotices) { this.lastNotices = notices; this.options.changed?.(); }
    const path = this.options.statusPath; if (!path) return;
    const plugins = Object.fromEntries([...this.roots].map(([id, r]) => [id, { root: r.root, state: r.state, version: r.version, message: r.message, code: r.code, at: r.at }]));
    const body = JSON.stringify({ pid: process.pid, catalog: this.options.sources.catalog.map(p => p.id), plugins, notices: info.notices });
    if (body === this.lastStatus) return;
    this.lastStatus = body;
    const temporary = `${path}.${process.pid}.tmp`;
    try { await mkdir(dirname(path), { recursive: true }); await writeFile(temporary, JSON.stringify({ ...JSON.parse(body), updatedAt: new Date().toISOString() })); await rename(temporary, path); }
    catch { /* The status file is a convenience for tooling; never let it affect the host. */ }
  }
}
/** Cheap change detector over package.json and dist/: null while either is absent (mid-build or never built). */
export async function devSignature(root: string): Promise<string | null> {
  const parts: string[] = [];
  const stat = async (path: string, label: string) => { const info = await lstat(path); parts.push(`${label}:${info.size}:${info.mtimeMs}:${info.ino}`); };
  try {
    await stat(join(root, "package.json"), "package.json");
    const walk = async (directory: string, label: string, depth: number): Promise<void> => {
      if (depth > 16 || parts.length > 8192) return;
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isDirectory()) await walk(join(directory, entry.name), `${label}/${entry.name}`, depth + 1); else await stat(join(directory, entry.name), `${label}/${entry.name}`);
      }
    };
    await walk(join(root, "dist"), "dist", 0);
    if (!parts.some(p => p.startsWith("dist/resources.json:"))) return null; // build.mjs writes the manifest last
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  return parts.join("|");
}
