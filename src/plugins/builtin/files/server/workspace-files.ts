import { constants } from "node:fs";
import { open, opendir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import type { WorkspaceFileEntry, WorkspaceFileListing, WorkspaceFilePreview } from "../contract/workspace-files.ts";

const MAX_ENTRIES = 1000;
const MAX_TEXT_BYTES = 512 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_LINES = 10000;
const names = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export class WorkspaceFileError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.name = "WorkspaceFileError"; this.status = status; }
}

function inside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/** Check both the authored path and its symlink-resolved target. */
async function workspacePath(cwd: string, path: string): Promise<string> {
  if (typeof path !== "string" || path.length > 4096 || path.includes("\0") || path.includes("\\") || isAbsolute(path) || win32.isAbsolute(path)) {
    throw new WorkspaceFileError("工作区文件路径无效");
  }
  const root = await realpath(cwd);
  const target = resolve(root, path);
  if (!inside(root, target)) throw new WorkspaceFileError("文件位于工作区之外", 403);
  const canonical = await realpath(target);
  if (!inside(root, canonical)) throw new WorkspaceFileError("文件位于工作区之外", 403);
  return canonical;
}

async function fileOperation<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof WorkspaceFileError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") throw new WorkspaceFileError("文件或目录已不存在", 404);
    if (code === "EACCES" || code === "EPERM") throw new WorkspaceFileError("没有权限读取文件或目录", 403);
    throw error;
  }
}

export async function listWorkspaceFiles(cwd: string, path: string): Promise<WorkspaceFileListing> {
  return fileOperation(async () => {
    const target = await workspacePath(cwd, path);
    const entries: WorkspaceFileEntry[] = [];
    let truncated = false;
    for await (const entry of await opendir(target)) {
      if (entries.length === MAX_ENTRIES) { truncated = true; break; }
      const child = path ? `${path}/${entry.name}` : entry.name;
      let kind: WorkspaceFileEntry["kind"] = entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other";
      if (entry.isSymbolicLink()) {
        try {
          const info = await stat(await workspacePath(cwd, child));
          kind = info.isDirectory() ? "directory" : info.isFile() ? "file" : "other";
        } catch { /* Broken, unreadable and escaping links remain visible but inert. */ }
      }
      entries.push({ name: entry.name, path: child, kind });
    }
    entries.sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || names.compare(a.name, b.name) || a.name.localeCompare(b.name));
    return { path, entries, truncated };
  });
}

/** Only inert raster formats are returned as images; SVG and HTML stay source text. */
function imageType(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}

export async function previewWorkspaceFile(cwd: string, path: string): Promise<WorkspaceFilePreview> {
  return fileOperation(async () => {
    const target = await workspacePath(cwd, path);
    if (!(await stat(target)).isFile()) throw new WorkspaceFileError("这不是可预览的普通文件");
    // Nonblocking and no-follow prevent a swapped FIFO/final symlink from being opened as a file.
    const file = await open(target, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new WorkspaceFileError("这不是可预览的普通文件");
      const meta = { path, size: info.size };
      const head = Buffer.alloc(16);
      await file.read(head, 0, head.length, 0);
      const mimeType = imageType(head);
      const limit = mimeType ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES;
      if (info.size > limit) return { ...meta, kind: "too-large", limit, unit: "bytes" };
      // Read at most limit + 1 even if the file grows after stat.
      const buffer = Buffer.alloc(Math.min(info.size + 1, limit + 1));
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > info.size) throw new WorkspaceFileError("文件正在变化，请重新读取", 409);
      const bytes = buffer.subarray(0, length);
      if (mimeType) return { ...meta, kind: "image", mimeType, data: bytes.toString("base64") };
      if (bytes.some(byte => byte === 0 || (byte < 32 && ![9, 10, 12, 13, 27].includes(byte)))) return { ...meta, kind: "unsupported" };
      let lines = 1;
      for (let index = 0; index < bytes.length - 1; index++) {
        if (bytes[index] === 10 && ++lines > MAX_TEXT_LINES) return { ...meta, kind: "too-large", limit: MAX_TEXT_LINES, unit: "lines" };
      }
      try { return { ...meta, kind: "text", text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) }; }
      catch { return { ...meta, kind: "unsupported" }; }
    } finally { await file.close(); }
  });
}
