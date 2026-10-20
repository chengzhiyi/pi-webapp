import { createHash } from 'node:crypto';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { DefaultPackageManager, getAgentDir, SettingsManager } from '@earendil-works/pi-coding-agent';

const leases = new Map<string, number>();

/** Compiled ESM entrypoints otherwise survive runtime replacement in Node's cache. */
export async function pluginRuntimePaths(cwd: string, roots: readonly string[]) {
  const manager = new DefaultPackageManager({ cwd, agentDir: getAgentDir(), settingsManager: SettingsManager.create(cwd) });
  const resolved = await manager.resolveExtensionSources([...roots], { temporary: true });
  const snapshots: string[] = [];
  const paths: string[] = [];
  const release = async () => {
    for (const path of snapshots.splice(0)) {
      const count = (leases.get(path) ?? 1) - 1;
      if (count) leases.set(path, count);
      else { leases.delete(path); await unlink(path).catch(() => {}); }
    }
  };
  try {
    for (const item of resolved.extensions) {
      if (!item.enabled) continue;
      const extension = extname(item.path);
      if (!['.js', '.mjs'].includes(extension)) { paths.push(item.path); continue; }
      const bytes = await readFile(item.path);
      const hash = createHash('sha256').update(bytes).digest('hex');
      // Keep the sibling location so relative imports and package resolution work.
      const path = join(dirname(item.path), `.pi-web-runtime-${basename(item.path, extension)}-${hash}${extension}`);
      await writeFile(path, bytes, { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
      leases.set(path, (leases.get(path) ?? 0) + 1);
      snapshots.push(path); paths.push(path);
    }
    return { paths, release };
  } catch (error) { await release(); throw error; }
}
