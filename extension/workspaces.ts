import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

/** Stable workspace registration for one canonical host directory. */
export interface WorkspaceView {
  id: string;
  path: string;
  title: string;
}

export class WorkspaceRegistry {
  private items: WorkspaceView[] = [];
  private hiddenPaths: string[] = [];
  private mutationChain: Promise<void> = Promise.resolve();
  private readonly file: string;

  constructor(file: string) { this.file = file; }

  async load(): Promise<void> {
    try {
      const value: unknown = JSON.parse(await readFile(this.file, "utf8"));
      let items: unknown;
      let hiddenPaths: unknown = [];
      if (Array.isArray(value)) items = value;
      else if (value && typeof value === "object" && "version" in value && value.version === 2 && "items" in value && "hiddenPaths" in value) {
        items = value.items;
        hiddenPaths = value.hiddenPaths;
      }
      if (!Array.isArray(items) || !Array.isArray(hiddenPaths)) throw new Error("工作区记录无效");
      this.items = items.filter((item): item is WorkspaceView =>
        typeof item === "object" && item !== null
        && typeof item.id === "string" && typeof item.path === "string" && typeof item.title === "string");
      this.hiddenPaths = hiddenPaths.filter((path): path is string => typeof path === "string");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  list(): WorkspaceView[] { return [...this.items]; }

  get(id: string): WorkspaceView | undefined { return this.items.find((item) => item.id === id); }

  async add(path: string, create = false): Promise<WorkspaceView> {
    if (!isAbsolute(path) || path.includes("\0")) throw new Error("请输入完整的目录路径");
    if (create) await mkdir(path, { recursive: true });
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory()) throw new Error("路径不是目录");
    return this.mutate(async () => {
      const hiddenPaths = this.hiddenPaths.filter((item) => item !== canonical);
      const existing = this.items.find((item) => item.path === canonical);
      if (existing) {
        if (hiddenPaths.length !== this.hiddenPaths.length) {
          await this.save(this.items, hiddenPaths);
          this.hiddenPaths = hiddenPaths;
        }
        return existing;
      }
      const workspace = { id: randomUUID(), path: canonical, title: basename(canonical) || canonical };
      const next = [workspace, ...this.items];
      await this.save(next, hiddenPaths);
      this.items = next;
      this.hiddenPaths = hiddenPaths;
      return workspace;
    });
  }

  /** Add directories found in Pi's saved sessions without undoing sidebar removals. */
  async discover(paths: string[]): Promise<void> {
    const canonical = (await Promise.all([...new Set(paths)].filter(isAbsolute).map(async (path) => {
      try {
        const resolved = await realpath(path);
        return (await stat(resolved)).isDirectory() ? resolved : null;
      } catch { return null; }
    }))).filter((path): path is string => path !== null);
    await this.mutate(async () => {
      const known = new Set([...this.items.map((item) => item.path), ...this.hiddenPaths]);
      const added: WorkspaceView[] = [];
      for (const path of canonical) {
        if (known.has(path)) continue;
        known.add(path);
        added.push({ id: randomUUID(), path, title: basename(path) || path });
      }
      if (added.length === 0) return;
      const next = [...this.items, ...added];
      await this.save(next, this.hiddenPaths);
      this.items = next;
    });
  }

  async remove(id: string): Promise<void> {
    await this.mutate(async () => {
      const workspace = this.get(id);
      if (!workspace) throw new Error("工作区不存在");
      const next = this.items.filter((item) => item.id !== id);
      const hiddenPaths = [...new Set([...this.hiddenPaths, workspace.path])];
      await this.save(next, hiddenPaths);
      this.items = next;
      this.hiddenPaths = hiddenPaths;
    });
  }

  private mutate<T>(action: () => Promise<T>): Promise<T> {
    const result = this.mutationChain.then(action, action);
    this.mutationChain = result.then(() => {}, () => {});
    return result;
  }

  private async save(items: WorkspaceView[], hiddenPaths: string[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ version: 2, items, hiddenPaths }, null, 2), { mode: 0o600 });
      await rename(temporary, this.file);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}

export function workspaceRegistryPath(agentDir: string): string {
  return join(agentDir, "pi-web", "workspaces.json");
}
