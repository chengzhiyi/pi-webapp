import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { join } from "node:path";
import { HostedPluginError, isMissing } from "../errors.ts";

/** Host-internal. Plugins never read secrets; the network broker injects them (see network.ts). */
export interface SecretStore {
  get(pluginId: string, name: string): Promise<string | null>;
  set(pluginId: string, name: string, value: string): Promise<void>;
  delete(pluginId: string, name: string): Promise<void>;
  has(pluginId: string, name: string): Promise<boolean>;
}
export class MemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>();
  private k = (p: string, n: string) => `${p}\0${n}`;
  async get(p: string, n: string) { return this.values.get(this.k(p, n)) ?? null; }
  async set(p: string, n: string, v: string) { this.values.set(this.k(p, n), v); }
  async delete(p: string, n: string) { this.values.delete(this.k(p, n)); }
  async has(p: string, n: string) { return this.values.has(this.k(p, n)); }
}
/** Interim 0600 file store. An OS-keychain adapter should implement SecretStore and replace it. */
export class FileSecretStore implements SecretStore {
  private readonly dir: string;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(root: string) { this.dir = join(root, "secrets"); }
  private file = (pluginId: string) => join(this.dir, `${createHash("sha256").update(pluginId).digest("hex")}.json`);
  private async read(pluginId: string): Promise<Record<string, string>> {
    try { const v = JSON.parse(await readFile(this.file(pluginId), "utf8")); if (v && typeof v === "object" && !Array.isArray(v)) return v; }
    catch (error) { if (!isMissing(error)) throw new HostedPluginError("invalid_storage", "Secret store is unreadable"); }
    return {};
  }
  private serialize<T>(op: () => Promise<T>): Promise<T> { const r = this.queue.then(op, op); this.queue = r.catch(() => {}); return r; }
  async get(p: string, n: string) { return (await this.read(p))[n] ?? null; }
  has(p: string, n: string) { return this.get(p, n).then(v => v !== null); }
  set(p: string, n: string, value: string) { return this.mutate(p, all => { all[n] = value; }); }
  delete(p: string, n: string) { return this.mutate(p, all => { delete all[n]; }); }
  private mutate(pluginId: string, change: (all: Record<string, string>) => void): Promise<void> {
    return this.serialize(async () => {
      const all = await this.read(pluginId); change(all);
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const tmp = `${this.file(pluginId)}.${randomUUID()}.tmp`;
      await writeFile(tmp, JSON.stringify(all), { mode: 0o600 });
      await rename(tmp, this.file(pluginId));
    });
  }
}
