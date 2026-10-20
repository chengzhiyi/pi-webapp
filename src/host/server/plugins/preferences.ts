import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

export class PluginManagementError extends Error {
  readonly status: number;
  constructor(message: string, status = 409) { super(message); this.status = status; }
}
/** Host-global opt-outs. Writes reject stale snapshots and never mutate state before durable save. */
export class PluginPreferences {
  private disabled = new Set<string>();
  private changing = false;
  readonly file: string;
  constructor(file: string) { this.file = file; }
  async load() {
    try {
      const data: unknown = JSON.parse(await readFile(this.file, "utf8"));
      if (!data || typeof data !== "object" || !("version" in data) || data.version !== 1 || !("disabled" in data) || !Array.isArray(data.disabled) || !data.disabled.every(id => typeof id === "string" && id.length > 0 && id.length <= 200)) throw new PluginManagementError("插件配置无效，请修复配置后重启", 503);
      this.disabled = new Set(data.disabled);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  enabled(id: string) { return !this.disabled.has(id); }
  revision() { return createHash("sha256").update(JSON.stringify([...this.disabled].sort())).digest("hex"); }
  async set(id: string, enabled: boolean, expected: string, guard: () => void): Promise<void> {
    if (this.changing) throw new PluginManagementError("插件配置正在保存，请稍后重试");
    this.changing = true;
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    const lockFile = `${this.file}.lock`;
    let lock: FileHandle | undefined;
    try {
      if (expected !== this.revision()) throw new PluginManagementError("插件配置已变化，请刷新后重试");
      guard();
      const next = new Set(this.disabled);
      if (enabled) next.delete(id); else next.add(id);
      await mkdir(dirname(this.file), { recursive: true });
      try { lock = await open(lockFile, "wx", 0o600); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new PluginManagementError("插件配置已被其他服务锁定，请稍后刷新重试"); throw error; }
      const durable = new PluginPreferences(this.file);
      await durable.load();
      if (durable.revision() !== expected) throw new PluginManagementError("插件配置已由其他服务修改，请重启当前服务后重试");
      await writeFile(temporary, JSON.stringify({ version: 1, disabled: [...next].sort() }, null, 2) + "\n", { mode: 0o600 });
      guard();
      await rename(temporary, this.file);
      this.disabled = next;
    } finally {
      this.changing = false;
      try { await rm(temporary, { force: true }); }
      finally { if (lock) { await lock.close(); await rm(lockFile, { force: true }); } }
    }
  }
}
