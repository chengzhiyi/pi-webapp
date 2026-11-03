import { createHash } from 'node:crypto';
import { readFile, realpath, writeFile, unlink } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, parse, relative, sep } from 'node:path';
import { DefaultPackageManager, getAgentDir, SettingsManager } from '@earendil-works/pi-coding-agent';

const leases = new Map<string, number>();

async function extensionPackageName(path: string): Promise<string | null> {
  let directory = dirname(path);
  while (directory !== parse(directory).root) {
    try {
      const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as { name?: unknown };
      if (typeof pkg.name === 'string') return pkg.name;
    } catch { /* Keep walking towards the package root. */ }
    directory = dirname(directory);
  }
  return null;
}

function inside(root: string, path: string): boolean {
  const rest = relative(root, path);
  return rest === '' || (rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
}

/** Load configured Pi extensions, but never recurse into any installed pi-webapp copy. */
export async function sessionRuntimePaths(cwd: string, webRoots: readonly string[], projectTrusted: boolean) {
  const settingsManager = SettingsManager.create(cwd, undefined, { projectTrusted });
  const manager = new DefaultPackageManager({ cwd, agentDir: getAgentDir(), settingsManager });
  const resolved = await manager.resolve(async () => 'skip');
  const canonicalWebRoots = await Promise.all(webRoots.map(root => realpath(root)));
  const configured = new Set<string>();
  for (const item of resolved.extensions) {
    if (!item.enabled || item.path.startsWith('builtin:')) continue;
    const path = await realpath(item.path);
    if (await extensionPackageName(path) === 'pi-webapp') continue;
    if (canonicalWebRoots.some(root => inside(root, path))) continue;
    configured.add(path);
  }
  // Only Web plugins need cache-busting snapshots. Ordinary Pi extensions keep
  // their original paths, so read-only installs are never written to.
  const web = await pluginRuntimePaths(cwd, canonicalWebRoots);
  return { paths: [...web.paths, ...configured], release: web.release };
}

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
  const seen = new Set<string>();
  try {
    for (const item of resolved.extensions) {
      if (!item.enabled || seen.has(item.path)) continue;
      seen.add(item.path);
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
