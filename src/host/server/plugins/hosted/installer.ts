import { createHash, timingSafeEqual } from "node:crypto";
import { lstat, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { isHostedPluginManifest } from "@chengzhiyi/pi-web-protocol";
import { extractHostedArchive, MAX_ARCHIVE_BYTES } from "./archive.ts";
import { HostedPluginError, isMissing } from "./errors.ts";
import { compatibleRelease, officialPlugin, OFFICIAL_PLUGINS, selectRelease, type OfficialPlugin, type RegistryRelease } from "./official-catalog.ts";
import { sha256, validateHostedPackage, type HostedPackage } from "./resources.ts";
import { atomicJson, boundedRead, privateDirectory, readJson, readJournal, withStorageLock } from "./storage.ts";
import { satisfiesHost, stableVersion } from "./versions.ts";

export interface InstalledHostedVersion { version: string; digest: string; integrity: string; directory: string; installedAt: string }
interface InstallationIndex { schema: 1; revision: number; versions: Record<string, InstalledHostedVersion[]> }
interface InstallJournal { schema: 1; pluginId: string; next: InstalledHostedVersion }
export interface InstallerOptions {
  root: string;
  hostVersion: string;
  catalog?: readonly OfficialPlugin[];
  fetch?: typeof globalThis.fetch;
}
export function verifyArchiveIntegrity(bytes: Buffer, integrity: string): void {
  // Official hosted artifacts require SHA-512 SRI. No registry SHA-1 fallback.
  const match = /^sha512-([A-Za-z0-9+/]{86}==)$/.exec(integrity);
  if (!match) throw new HostedPluginError("invalid_integrity", "A single SHA-512 tarball integrity is required");
  const expected = Buffer.from(match[1]!, "base64"), actual = createHash("sha512").update(bytes).digest();
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new HostedPluginError("integrity_mismatch", "Downloaded package failed integrity verification");
}
/** New code is staged and validated before it becomes installed; active code is never overwritten. */
export class HostedPluginInstaller {
  readonly root: string;
  readonly hostVersion: string;
  readonly catalog: readonly OfficialPlugin[];
  private readonly fetcher: typeof globalThis.fetch;
  constructor(options: InstallerOptions) {
    if (!stableVersion(options.hostVersion)) throw new HostedPluginError("invalid_version", "Host requires an exact stable version");
    this.root = options.root; this.hostVersion = options.hostVersion; this.catalog = options.catalog ?? OFFICIAL_PLUGINS; this.fetcher = options.fetch ?? globalThis.fetch;
  }
  private async index(): Promise<InstallationIndex> {
    const index = await readJson<InstallationIndex>(join(this.root, "installed.json"));
    if (!index) {
      if (await boundedRead(join(this.root, "installed.json"), 2 * 1024 * 1024)) throw new HostedPluginError("invalid_storage", "Null installation index; restore metadata before cleanup");
      return { schema: 1, revision: 0, versions: {} };
    }
    if (index.schema !== 1 || !Number.isSafeInteger(index.revision) || index.revision < 0 || !index.versions || typeof index.versions !== "object" || Array.isArray(index.versions)) throw new HostedPluginError("invalid_storage", "Invalid plugin installation index");
    for (const [id, versions] of Object.entries(index.versions)) {
      officialPlugin(id, this.catalog);
      if (!Array.isArray(versions) || versions.length > 16 || new Set(versions.map(v => v.version)).size !== versions.length) throw new HostedPluginError("invalid_storage", "Invalid installed version list");
      for (const version of versions) this.validateRecord(id, version);
    }
    return index;
  }
  private validateRecord(id: string, value: InstalledHostedVersion) {
    if (!value || !stableVersion(value.version) || !/^[a-f0-9]{64}$/.test(value.digest) || value.directory !== `${sha256(id)}/${value.version}-${value.digest}` || typeof value.integrity !== "string" || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(value.integrity) || typeof value.installedAt !== "string") throw new HostedPluginError("invalid_storage", "Invalid installed plugin record");
  }
  private path(record: InstalledHostedVersion): string { return join(this.root, "versions", record.directory); }
  private async recoverLocked(): Promise<InstallationIndex> {
    const index = await this.index(), journal = await readJournal<InstallJournal>(join(this.root, "install-journal.json"));
    if (journal) {
      if (journal.schema !== 1 || Object.keys(journal).some(k => !["schema", "pluginId", "next"].includes(k))) throw new HostedPluginError("invalid_storage", "Invalid install journal");
      officialPlugin(journal.pluginId, this.catalog); this.validateRecord(journal.pluginId, journal.next);
      // Index is the only installed source of truth. A renamed but uncommitted package is an orphan,
      // not permission to start code after a crash. Keep it for validation/retry, never execute it.
      const referenced = index.versions[journal.pluginId]?.find(v => v.version === journal.next.version);
      if (referenced && referenced.digest !== journal.next.digest) throw new HostedPluginError("invalid_storage", "Conflicting installation journal");
      await rm(join(this.root, "install-journal.json"));
    }
    await this.recoverCollection(index);
    // No concurrent installer can own a stage while holding this root lock.
    const staging = join(this.root, "staging"); await privateDirectory(staging);
    for (const name of await readdir(staging)) {
      if (!/^stage-[A-Za-z0-9]+$/.test(name) || (await lstat(join(staging, name))).isSymbolicLink()) throw new HostedPluginError("invalid_storage", "Invalid abandoned staging directory");
      await rm(join(staging, name), { recursive: true });
    }
    return index;
  }
  private async recoverCollection(index: InstallationIndex): Promise<void> {
    const path = join(this.root, "gc-journal.json");
    const journal = await readJournal<{ schema: number; pluginId: string; records: InstalledHostedVersion[] }>(path);
    if (!journal) return;
    if (journal.schema !== 1 || Object.keys(journal).some(k => !["schema", "pluginId", "records"].includes(k)) || !Array.isArray(journal.records) || !journal.records.length) throw new HostedPluginError("gc_recovery_required", "Invalid gc-journal.json; stop all owners and inspect it before cleanup");
    officialPlugin(journal.pluginId, this.catalog);
    for (const record of journal.records) this.validateRecord(journal.pluginId, record);
    const referenced = journal.records.filter(record => index.versions[journal.pluginId]?.some(v => v.directory === record.directory));
    if (referenced.length && referenced.length !== journal.records.length) throw new HostedPluginError("gc_recovery_required", "Conflicting GC journal/index; restore installation metadata before cleanup");
    if (!referenced.length) {
      await privateDirectory(join(this.root, "versions"));
      await privateDirectory(join(this.root, "versions", sha256(journal.pluginId)));
      for (const record of journal.records) await rm(this.path(record), { recursive: true, force: true });
    }
    // All referenced means the index commit never happened; abort this GC without deleting code.
    await rm(path);
  }
  /** References are sampled UNDER the installer lock, not from an earlier inventory.
   * The manager additionally owns its operation fence and broker lock.
   */
  async collect(id: string, references: () => Promise<readonly string[]>): Promise<string[]> {
    officialPlugin(id, this.catalog);
    return withStorageLock(this.root, async () => {
      const index = await this.recoverLocked(), versions = index.versions[id] ?? [];
      const keep = new Set(await references());
      // Keep the latest accepted installation as well (install is deliberately separate from enable).
      const latest = versions.at(-1); if (latest) keep.add(latest.version);
      const remove = versions.filter(v => !keep.has(v.version));
      await this.removeLocked(id, index, remove);
      return remove.map(v => v.version);
    });
  }
  private async removeLocked(id: string, index: InstallationIndex, remove: InstalledHostedVersion[]): Promise<void> {
    if (!remove.length) return;
    await privateDirectory(join(this.root, "versions"));
    await privateDirectory(join(this.root, "versions", sha256(id)));
    await atomicJson(join(this.root, "gc-journal.json"), { schema: 1, pluginId: id, records: remove });
    index.versions[id] = (index.versions[id] ?? []).filter(v => !remove.some(r => r.directory === v.directory)); index.revision++;
    // Deregister first. Recovery deletes only if the entire atomic removal committed.
    await atomicJson(join(this.root, "installed.json"), index);
    await this.recoverCollection(index);
  }
  async inventory(): Promise<{ revision: number; versions: Record<string, InstalledHostedVersion[]> }> {
    return withStorageLock(this.root, async () => { const index = await this.recoverLocked(); return { revision: index.revision, versions: structuredClone(index.versions) }; });
  }
  private trustedUrl(value: string, plugin: OfficialPlugin): URL {
    let url: URL;
    try { url = new URL(value); } catch { throw new HostedPluginError("registry_denied", "Invalid registry URL"); }
    const registry = new URL(plugin.registry);
    if (url.protocol !== "https:" || url.origin !== registry.origin || url.username || url.password || url.hash || url.search) throw new HostedPluginError("registry_denied", "Only the official registry origin is permitted");
    return url;
  }
  private async download(url: URL, limit: number, signal?: AbortSignal): Promise<Buffer> {
    const abort = AbortSignal.any([AbortSignal.timeout(60_000), ...(signal ? [signal] : [])]);
    const response = await this.fetcher(url, { redirect: "error", signal: abort, headers: { Accept: "application/json, application/octet-stream" } });
    if (!response.ok || !response.body) throw new HostedPluginError("download_failed", `Registry download failed (${response.status})`);
    if (response.url && new URL(response.url).origin !== url.origin) throw new HostedPluginError("registry_denied", "Registry redirect is forbidden");
    const reader = response.body.getReader(), chunks: Buffer[] = []; let length = 0;
    try {
      if (Number(response.headers.get("content-length")) > limit) throw new HostedPluginError("download_too_large", "Registry response exceeds budget");
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        length += next.value.length;
        if (length > limit) throw new HostedPluginError("download_too_large", "Registry response exceeds budget");
        chunks.push(Buffer.from(next.value));
      }
      abort.throwIfAborted(); return Buffer.concat(chunks);
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  async check(id: string, installedVersion?: string, exact?: string, signal?: AbortSignal): Promise<RegistryRelease> {
    const plugin = officialPlugin(id, this.catalog);
    if (exact && !stableVersion(exact)) throw new HostedPluginError("invalid_version", "Choose an exact stable version");
    const url = this.trustedUrl(`${plugin.registry}/${encodeURIComponent(id)}`, plugin);
    let metadata: unknown;
    const bytes = await this.download(url, 8 * 1024 * 1024, signal);
    try { metadata = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new HostedPluginError("registry_invalid", "Invalid registry metadata JSON"); }
    return selectRelease(metadata, plugin, this.hostVersion, installedVersion, exact);
  }
  async install(id: string, release: RegistryRelease, signal?: AbortSignal): Promise<HostedPackage> {
    const plugin = officialPlugin(id, this.catalog);
    if (!compatibleRelease(release, plugin, this.hostVersion)) throw new HostedPluginError("incompatible_plugin", "Plugin release is incompatible with this host");
    const bytes = await this.download(this.trustedUrl(release.dist.tarball, plugin), MAX_ARCHIVE_BYTES, signal);
    return this.installArchive(id, bytes, release.dist.integrity, release.version, signal);
  }
  /** Local tgz verification uses exactly the same extraction/validation/commit path; no npm scripts. */
  async installArchive(id: string, bytes: Buffer, integrity: string, expectedVersion: string, signal?: AbortSignal): Promise<HostedPackage> {
    const plugin = officialPlugin(id, this.catalog);
    if (!stableVersion(expectedVersion)) throw new HostedPluginError("invalid_version", "Choose an exact stable version");
    if (bytes.length > MAX_ARCHIVE_BYTES) throw new HostedPluginError("download_too_large", "Package archive exceeds budget");
    verifyArchiveIntegrity(bytes, integrity);
    return withStorageLock(this.root, async () => {
      const index = await this.recoverLocked(); signal?.throwIfAborted();
      const staging = await mkdtemp(join(this.root, "staging", "stage-"));
      try {
        await extractHostedArchive(bytes, staging); signal?.throwIfAborted();
        const pkg = await validateHostedPackage(staging, id);
        if (pkg.version !== expectedVersion || !isHostedPluginManifest(pkg.manifest) || !satisfiesHost(this.hostVersion, pkg.manifest.hostRange) || !plugin.requiredCapabilities.every(c => pkg.manifest.capabilities.includes(c))) throw new HostedPluginError("incompatible_plugin", "Archive version/capabilities differ from selected release");
        const old = index.versions[id]?.find(v => v.version === pkg.version);
        if (old && old.digest !== pkg.digest) throw new HostedPluginError("version_replaced", "An installed immutable version cannot be replaced with different content");
        const record: InstalledHostedVersion = { version: pkg.version, digest: pkg.digest, integrity, directory: `${sha256(id)}/${pkg.version}-${pkg.digest}`, installedAt: new Date().toISOString() };
        await privateDirectory(join(this.root, "versions", sha256(id)));
        if (!old && (index.versions[id]?.length ?? 0) >= 16) throw new HostedPluginError("version_budget", "Retained plugin version budget reached; collect unreferenced versions first");
        await atomicJson(join(this.root, "install-journal.json"), { schema: 1, pluginId: id, next: record } satisfies InstallJournal);
        const destination = this.path(record);
        let exists = false;
        try { await lstat(destination); exists = true; } catch (error) { if (!isMissing(error)) throw error; }
        if (exists) {
          const installed = await validateHostedPackage(destination, id);
          if (installed.digest !== pkg.digest) throw new HostedPluginError("resource_changed", "Installed package content was modified");
        } else await rename(staging, destination);
        signal?.throwIfAborted();
        if (!old) {
          index.versions[id] = [...(index.versions[id] ?? []), record]; index.revision++;
          await atomicJson(join(this.root, "installed.json"), index);
        }
        await rm(join(this.root, "install-journal.json"));
        return { ...pkg, root: destination };
      } finally { await rm(staging, { recursive: true, force: true }); }
    }, 10_000);
  }
  async load(id: string, version: string): Promise<HostedPackage> {
    officialPlugin(id, this.catalog);
    return withStorageLock(this.root, async () => {
      const index = await this.recoverLocked(), record = index.versions[id]?.find(v => v.version === version);
      if (!record) throw new HostedPluginError("not_installed", "Plugin version is not installed");
      const pkg = await validateHostedPackage(this.path(record), id);
      if (pkg.digest !== record.digest) throw new HostedPluginError("resource_changed", "Installed package integrity changed");
      if (!satisfiesHost(this.hostVersion, pkg.manifest.hostRange)) throw new HostedPluginError("incompatible_plugin", "Installed plugin is incompatible with this host");
      return pkg;
    });
  }
  /** Caller must hold lifecycle admission and exclude active/pending/referenced versions. Keeps data elsewhere. */
  async removeVersions(id: string, removable: readonly string[]): Promise<void> {
    officialPlugin(id, this.catalog);
    await withStorageLock(this.root, async () => {
      const index = await this.recoverLocked(), old = index.versions[id] ?? [];
      const remove = old.filter(v => removable.includes(v.version));
      await this.removeLocked(id, index, remove);
    });
  }
}
