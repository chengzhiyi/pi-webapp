import { copyFile, mkdir, rename, unlink } from "node:fs/promises";
import { basename, join } from "node:path";

/** Deleted chats are moved here, not erased, so a mistaken delete can be undone by moving the file back. */
export const sessionTrashDirectory = (agentDir: string) => join(agentDir, "pi-web", "trash");

/** Moves a session file into the trash; an already missing file counts as deleted. Returns the new path. */
export async function moveSessionToTrash(path: string, agentDir: string): Promise<string | null> {
  const directory = sessionTrashDirectory(agentDir);
  await mkdir(directory, { recursive: true });
  const target = join(directory, `${Date.now()}_${basename(path)}`);
  try { await rename(path, target); }
  catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code !== "EXDEV") throw cause;
    await copyFile(path, target);
    await unlink(path);
  }
  return target;
}
