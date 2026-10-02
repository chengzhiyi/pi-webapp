import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// The release helper is plain JavaScript so it can run before npm ci.
// @ts-expect-error No declaration file is needed for this CI-only module.
import { syncProtocolDependency } from '../scripts/sync-protocol-dependency.mjs';

test('CI replaces the local protocol link with the exact published version before installation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-protocol-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), JSON.stringify({ devDependencies: { '@chengzhiyi/pi-web-protocol': 'file:../pi-extensions/packages/protocol' } }));
  let args: string[] = [];
  const version = await syncProtocolDependency({ root, request: async () => Response.json({ version: '0.1.3' }),
    run: (_command: string, values: string[]) => { args = values; } });
  assert.equal(version, '0.1.3');
  assert(args.includes('--save-exact'));
  assert(args.includes('--package-lock-only'));
  assert(args.includes('@chengzhiyi/pi-web-protocol@0.1.3'));
});

test('missing, unavailable, or prerelease protocol metadata stops CI before any mutation', async () => {
  for (const response of [new Response('', { status: 404 }), new Response('', { status: 503 }), Response.json({ version: '0.2.0-beta.1' })]) {
    await assert.rejects(syncProtocolDependency({ root: '/does-not-exist', request: async () => response,
      run: () => assert.fail('unexpected npm install') }), /protocol|stable/i);
  }
});

test('unpublished protocol can use a built pinned checkout for verification only', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-protocol-bootstrap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, '.ci/pi-extensions/packages/protocol');
  await mkdir(join(source, 'dist'), { recursive: true });
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: '@chengzhiyi/pi-web-protocol', version: '0.1.0', main: './dist/index.js', types: './dist/index.d.ts' }));
  await writeFile(join(source, 'dist/index.js'), 'export {};');
  await writeFile(join(source, 'dist/index.d.ts'), 'export {};');
  await writeFile(join(root, 'package.json'), JSON.stringify({ devDependencies: {} }));
  let args: string[] = [];
  const result = await syncProtocolDependency({ root, source, request: async () => new Response('', { status: 404 }),
    run: (_command: string, values: string[]) => { args = values; } });
  assert.equal(result, 'file:.ci/pi-extensions/packages/protocol');
  assert(args.includes('@chengzhiyi/pi-web-protocol@file:.ci/pi-extensions/packages/protocol'));
  assert.equal(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).devDependencies['@chengzhiyi/pi-web-protocol'], undefined);
  await assert.rejects(syncProtocolDependency({ root, source, request: async () => new Response('', { status: 503 }) }), /503/);
  await rm(join(source, 'dist/index.d.ts'));
  await assert.rejects(syncProtocolDependency({ root, source, request: async () => new Response('', { status: 404 }) }), /ENOENT/);
});
