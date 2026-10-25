import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
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

test('published exact protocol pins are verified without following a newer latest or mutating the lock', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-protocol-pin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), JSON.stringify({ devDependencies: { '@chengzhiyi/pi-web-protocol': '0.1.1' } }));
  const run = () => assert.fail('an exact published pin must not change');
  assert.equal(await syncProtocolDependency({ root, request: async (url: string) => {
    assert(url.endsWith('/0.1.1')); return Response.json({ version: '0.1.1' });
  }, run }), '0.1.1');
  await assert.rejects(syncProtocolDependency({ root, request: async () => Response.json({ version: '0.1.2' }), run }), /expected pinned/);
});

test('missing, unavailable, or prerelease protocol metadata stops CI before any mutation', async () => {
  for (const response of [new Response('', { status: 404 }), new Response('', { status: 503 }), Response.json({ version: '0.2.0-beta.1' })]) {
    await assert.rejects(syncProtocolDependency({ root: '/does-not-exist', request: async () => response,
      run: () => assert.fail('unexpected npm install') }), /protocol|stable/i);
  }
});

test('locked v2 development snapshots survive verification but never authorize release or network downgrade', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-protocol-snapshot-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'vendor'));
  const specifier = 'file:vendor/protocol-0.2.0-dev.0.tgz', bytes = Buffer.from('immutable-package-fixture');
  await writeFile(join(root, 'vendor/protocol-0.2.0-dev.0.tgz'), bytes);
  await writeFile(join(root, 'package.json'), JSON.stringify({ devDependencies: { '@chengzhiyi/pi-web-protocol': specifier } }));
  await writeFile(join(root, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/@chengzhiyi/pi-web-protocol': {
    version: '0.2.0-dev.0', resolved: specifier, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
  } } }));
  const request = () => assert.fail('snapshot verification must not resolve registry latest');
  const run = () => assert.fail('snapshot verification must not mutate the pinned dependency');
  assert.equal(await syncProtocolDependency({ root, source: '.ci/protocol', request, run }), specifier);
  await assert.rejects(syncProtocolDependency({ root, request, run }), /verification-only/);
  await writeFile(join(root, 'vendor/protocol-0.2.0-dev.0.tgz'), 'tampered');
  await assert.rejects(syncProtocolDependency({ root, source: '.ci/protocol', request, run }), /integrity/);
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
