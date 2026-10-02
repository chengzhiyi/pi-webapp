import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
