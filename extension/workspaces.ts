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
  private mutationChain: Promise<void> = Promise.resolve();
  private readonly file: string;

  constructor(file: string) { this.file = file; }

  async load(): Promise<void> {
    try {
      const value: unknown = JSON.parse(await readFile(this.file, "utf8"));
      if (!Array.isArray(value)) throw new Error("工作区记录无效");
      this.items = value.filter((item): item is WorkspaceView =>
        typeof item === "object" && item !== null
        && typeof item.id === "string" && typeof item.path === "string" && typeof item.title === "string");
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
      const existing = this.items.find((item) => item.path === canonical);
      if (existing) return existing;
      const workspace = { id: randomUUID(), path: canonical, title: basename(canonical) || canonical };
      const next = [workspace, ...this.items];
      await this.save(next);
      this.items = next;
      return workspace;
    });
  }

  async remove(id: string): Promise<void> {
    await this.mutate(async () => {
      if (!this.get(id)) throw new Error("工作区不存在");
      const next = this.items.filter((item) => item.id !== id);
      await this.save(next);
      this.items = next;
    });
  }

  private mutate<T>(action: () => Promise<T>): Promise<T> {
    const result = this.mutationChain.then(action, action);
    this.mutationChain = result.then(() => {}, () => {});
    return result;
  }

  private async save(items: WorkspaceView[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(items, null, 2), { mode: 0o600 });
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
