import { execFileSync } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const name = '@chengzhiyi/pi-web-protocol';

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
    const published = await publishedProtocolVersion() !== null;
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `published=${published}\n`);
    if (!published) {
      const message = 'The protocol package has not been published to npm. Verification will build the pinned source checkout; host publication waits for the first protocol release. Rerun this workflow after npm initialization.';
      console.log(`::warning::${message}`);
      if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `### Protocol initialization required\n\n${message}\n`);
    }
  } else {
    const source = process.argv[2] === '--source' ? process.argv[3] : undefined;
    await syncProtocolDependency({ source });
  }
}
