// Run the same host policy/admission tests against an explicitly installed SDK
// closure. This command never installs dependencies or changes release pins.
import { mkdtemp, mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

const prefix = process.argv[2] && resolve(process.argv[2]);
if (!prefix) throw new Error('Pass the absolute prefix containing the explicitly installed SDK node_modules');
const root = resolve(import.meta.dirname, '..');
const output = await mkdtemp(join(tmpdir(), 'pi-hosted-sdk-contract-'));
await mkdir(join(output, 'node_modules', '@earendil-works'), { recursive: true });
const versions = {};
for (const name of ['pi-coding-agent', 'pi-ai', 'pi-agent-core']) {
  const target = join(prefix, 'node_modules', '@earendil-works', name);
  versions[name] = JSON.parse(await readFile(join(target, 'package.json'), 'utf8')).version;
  await symlink(target, join(output, 'node_modules', '@earendil-works', name), process.platform === 'win32' ? 'junction' : 'dir');
}
// Non-SDK host dependencies use the repository lockfile closure. They cannot
// cause the selected SDK imports above to resolve back to the host's version.
for (const entry of await readdir(join(root, 'node_modules'), { withFileTypes: true })) {
  if (entry.name.startsWith('@')) {
    await mkdir(join(output, 'node_modules', entry.name), { recursive: true });
    for (const name of await readdir(join(root, 'node_modules', entry.name))) {
      try { await symlink(join(root, 'node_modules', entry.name, name), join(output, 'node_modules', entry.name, name), process.platform === 'win32' ? 'junction' : 'dir'); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
  } else await symlink(join(root, 'node_modules', entry.name), join(output, 'node_modules', entry.name), process.platform === 'win32' ? 'junction' : 'dir');
}
const names = ['hosted-agent', 'hosted-agent-policy', 'hosted-agent-request-id', 'hosted-sdk-contract', 'model-transport'];
for (const name of names) await build({ entryPoints: [join(root, 'test', `${name}.test.ts`)], outfile: join(output, `${name}.test.mjs`), bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' });
await writeFile(join(output, 'versions.json'), JSON.stringify(versions, null, 2));
const run = promisify(execFile);
try {
  const { stdout, stderr } = await run(process.execPath, ['--import', join(root, 'test/setup-env.mjs'), '--test', ...names.map(name => join(output, `${name}.test.mjs`))], { cwd: root, timeout: 90_000, maxBuffer: 4 * 1024 * 1024 });
  await writeFile(join(output, 'test.log'), stdout + stderr);
  console.log(JSON.stringify({ versions, output, status: 'passed' })); console.log(stdout);
} catch (error) { await writeFile(join(output, 'test.log'), (error.stdout ?? '') + (error.stderr ?? '')); console.error(JSON.stringify({ versions, output, status: 'failed' })); throw error; }
