import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const name = '@chengzhiyi/pi-web-protocol';

/** Resolve the registry dependency before npm ci; a sibling checkout is never required in CI. */
export async function syncProtocolDependency({ root = process.cwd(), request = fetch, run = execFileSync } = {}) {
  const response = await request(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, { signal: AbortSignal.timeout(30000) });
  if (response.status === 404) throw new Error(`Publish ${name} from pi-extensions before running pi-webapp CI`);
  if (!response.ok) throw new Error(`Protocol registry lookup failed: HTTP ${response.status}`);
  const { version } = await response.json();
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Expected a stable protocol version, got ${version}`);
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (manifest.devDependencies?.[name] !== version) {
    run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--save-dev', '--save-exact', `${name}@${version}`], { cwd: root, stdio: 'inherit' });
  }
  console.log(`Using published protocol ${name}@${version}`);
  return version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await syncProtocolDependency();
}
