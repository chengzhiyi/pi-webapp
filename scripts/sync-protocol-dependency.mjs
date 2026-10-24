import { execFileSync } from 'node:child_process';
import { appendFile, lstat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const name = '@chengzhiyi/pi-web-protocol';

/** A checked-in, lock-integrity-bound development artifact is verification-only.
 * Never silently replace a v2 snapshot with the registry's older v1 latest.
 */
export async function configuredProtocolSnapshot(root = process.cwd()) {
  let manifest;
  try { manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const specifier = manifest.devDependencies?.[name];
  if (typeof specifier !== 'string' || !specifier.startsWith('file:vendor/')) return null;
  if (!/^file:vendor\/[a-z0-9.-]+\.tgz$/.test(specifier)) throw new Error('Invalid protocol snapshot path');
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  const entry = lock.packages?.[`node_modules/${name}`];
  if (entry?.resolved !== specifier || !/^\d+\.\d+\.\d+-dev\.\d+$/.test(entry.version) || typeof entry.integrity !== 'string' || !entry.integrity.startsWith('sha512-')) throw new Error('Protocol snapshot must be bound to the development lockfile');
  const file = join(root, specifier.slice(5));
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) throw new Error('Invalid protocol snapshot file');
  const bytes = await readFile(file);
  if (`sha512-${createHash('sha512').update(bytes).digest('base64')}` !== entry.integrity) throw new Error('Protocol snapshot integrity mismatch');
  return specifier;
}

export async function publishedProtocolVersion(request = fetch) {
  const response = await request(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, { signal: AbortSignal.timeout(30000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Protocol registry lookup failed: HTTP ${response.status}`);
  const { version } = await response.json();
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Expected a stable protocol version, got ${version}`);
  return version;
}

/** Release builds require npm; verification may explicitly use a built, pinned source checkout on 404. */
export async function syncProtocolDependency({ root = process.cwd(), source, request = fetch, run = execFileSync } = {}) {
  const snapshot = await configuredProtocolSnapshot(root);
  if (snapshot) {
    if (!source) throw new Error('Development protocol snapshot is verification-only; publish and pin the reviewed protocol before releasing');
    console.log(`Verification preserves locked protocol snapshot ${snapshot}; release publication remains blocked`);
    return snapshot;
  }
  let version = await publishedProtocolVersion(request);
  if (version === null) {
    if (!source) throw new Error(`Publish ${name} from pi-extensions before releasing pi-webapp`);
    const directory = resolve(root, source);
    const protocol = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    if (protocol.name !== name || protocol.main !== './dist/index.js' || protocol.types !== './dist/index.d.ts') {
      throw new Error('Invalid protocol source package');
    }
    await Promise.all(['dist/index.js', 'dist/index.d.ts'].map(file => readFile(join(directory, file))));
    version = `file:${relative(root, directory).split('\\').join('/')}`;
    console.log(`Protocol is not published yet; verification uses ${version}`);
  }
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (manifest.devDependencies?.[name] !== version) {
    run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--save-dev', '--save-exact', `${name}@${version}`], { cwd: root, stdio: 'inherit' });
  }
  console.log(`Using protocol ${name}@${version}`);
  return version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === '--probe') {
    const snapshot = await configuredProtocolSnapshot();
    const published = !snapshot && await publishedProtocolVersion() !== null;
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `published=${published}\n`);
    if (!published) {
      const message = snapshot
        ? 'Verification uses a locked development protocol snapshot; host publication is blocked until the reviewed protocol is published and pinned.'
        : 'The protocol package has not been published to npm. Verification will build the pinned source checkout; host publication waits for the first protocol release. Rerun this workflow after npm initialization.';
      console.log(`::warning::${message}`);
      if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `### Protocol initialization required\n\n${message}\n`);
    }
  } else {
    const source = process.argv[2] === '--source' ? process.argv[3] : undefined;
    await syncProtocolDependency({ source });
  }
}
