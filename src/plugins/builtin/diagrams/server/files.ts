import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DiagramError, MAX_SCENE_BYTES, validateScene, type DiagramScene } from "../contract/diagrams.ts";

const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
function inside(root: string, path: string) { const r = relative(root, path); return r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r); }
async function targetPath(cwd: string, path: unknown, createParent = false) {
  if (typeof path !== "string" || path.length > 4096 || !path.endsWith(".excalidraw") || path.includes("\\") || path.includes("\0") || isAbsolute(path) || win32.isAbsolute(path)) throw new DiagramError("请使用工作区内的 .excalidraw 相对路径");
  const root = await realpath(cwd), target = resolve(root, path);
  if (!inside(root, target) || target === root) throw new DiagramError("图稿路径越界", 403);
  // Deliberately reject all symlinks, even in-workspace links, rather than writing through aliases.
  const segments = relative(root, target).split(sep);
  let current = root;
  for (let i = 0; i < segments.length; i++) {
    current = join(current, segments[i]!);
    let info;
    try { info = await lstat(current); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      if (i < segments.length - 1) {
        // Only the conventional default directory is created automatically.
        if (!createParent || relative(root, current) !== "diagrams") throw new DiagramError("保存目录不存在", 404);
        try { await mkdir(current, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        info = await lstat(current);
      }
    }
    if (info?.isSymbolicLink()) throw new DiagramError("图稿路径不能包含符号链接", 403);
    if (info && (i < segments.length - 1 ? !info.isDirectory() : !info.isFile())) throw new DiagramError("图稿路径不是普通文件");
  }
  const parent = await realpath(dirname(target));
  if (!inside(root, parent)) throw new DiagramError("图稿路径越界", 403);
  return { target, parent };
}
async function readBytes(target: string): Promise<Buffer | null> {
  let file;
  try { file = await open(target, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_SCENE_BYTES) throw new DiagramError("不是普通文件或图稿超过 512 KiB");
    const buffer = Buffer.alloc(MAX_SCENE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) { const { bytesRead } = await file.read(buffer, length, buffer.length - length, length); if (!bytesRead) break; length += bytesRead; }
    if (length > MAX_SCENE_BYTES) throw new DiagramError("图稿超过 512 KiB");
    return buffer.subarray(0, length);
  } finally { await file.close(); }
}
function diskError(error: unknown): never {
  if (error instanceof DiagramError) throw error;
  const code = (error as NodeJS.ErrnoException).code;
  if (["EACCES", "EPERM", "ELOOP"].includes(code ?? "")) throw new DiagramError("图稿不可访问或包含符号链接", 403);
  if (["ENOENT", "ENOTDIR"].includes(code ?? "")) throw new DiagramError("图稿目录不存在", 404);
  if (code === "EEXIST") throw new DiagramError("图稿正在保存；请稍后重试（不要删除活跃的锁文件）", 409);
  throw error;
}
export async function readDiagram(cwd: string, path: unknown): Promise<{ scene: DiagramScene; hash: string }> {
  try {
    const { target } = await targetPath(cwd, path);
    const bytes = await readBytes(target);
    if (!bytes) throw new DiagramError("图稿不存在", 404);
    let scene: unknown;
    try { scene = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new DiagramError("图稿不是有效的 UTF-8 JSON"); }
    return { scene: validateScene(scene), hash: hash(bytes) };
  } catch (e) { return diskError(e); }
}
/** Cooperative sibling lock + bounded content hash + atomic replacement. No blind overwrite API. */
export async function saveDiagram(cwd: string, path: unknown, scene: DiagramScene, expectedHash: string | null, guard: () => void = () => {}): Promise<string> {
  const bytes = JSON.stringify(validateScene(scene));
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  let lockPath: string | undefined, temp: string | undefined;
  try {
    const { target, parent } = await targetPath(cwd, path, true);
    lockPath = `${target}.lock`;
    lock = await open(lockPath, "wx", 0o600);
    await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    const before = await readBytes(target);
    if ((before ? hash(before) : null) !== expectedHash) throw new DiagramError("文件已存在或被外部修改；请重新打开或另存，未覆盖原文件", 409);
    temp = join(parent, `.diagram-${randomUUID()}.tmp`);
    const file = await open(temp, "wx", 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    const checked = await targetPath(cwd, path);
    if (checked.parent !== parent) throw new DiagramError("保存目录发生变化", 409);
    const latest = await readBytes(target);
    if ((latest ? hash(latest) : null) !== expectedHash) throw new DiagramError("保存期间文件发生变化；未覆盖", 409);
    guard(); // Session and draft revision are rechecked immediately before the commit.
    if (expectedHash === null) {
      // Atomic no-replace creation, including an external writer racing the final check.
      try { await link(temp, target); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new DiagramError("目标文件已存在；请另存", 409); throw error; }
      await unlink(temp); temp = undefined;
    } else { await rename(temp, target); temp = undefined; }
    return hash(bytes);
  } catch (error) { return diskError(error); }
  finally {
    if (temp) await unlink(temp).catch(() => {});
    if (lock) { await lock.close(); await unlink(lockPath!).catch(() => {}); }
  }
}
