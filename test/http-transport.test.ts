import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import { createEnvironmentFetch } from '../bin/http-transport.mjs';
import { integrationFixture } from './helpers/hosted-integration-fixture.ts';
import { verifyArchiveIntegrity } from '../src/host/server/plugins/hosted/installer.ts';

async function route(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void) {
  const server = createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  let tunnels = 0; const closed: Promise<unknown>[] = [];
  const proxy = createServer(); proxy.on('connect', (_req, socket, head) => {
    tunnels++; closed.push(once(socket, 'close'));
    const remote = connect((server.address() as any).port, '127.0.0.1', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) remote.write(head); socket.pipe(remote); remote.pipe(socket); });
    remote.on('error', () => socket.destroy()); socket.on('error', () => remote.destroy());
  });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  return { server, proxy, closed, count: () => tunnels, env: { HTTP_PROXY: `http://127.0.0.1:${(proxy.address() as any).port}`, NO_PROXY: '' }, stop() { server.closeAllConnections(); server.close(); proxy.closeAllConnections(); proxy.close(); } };
}
test('neutral HTTP transport downloads actual tgz bytes through CONNECT, verifies integrity and releases its lease', async t => {
  const fixture = integrationFixture();
  const h = await route((_req, res) => { res.writeHead(200, { 'content-length': String(fixture.bytes.length) }); res.end(fixture.bytes); });
  t.after(() => h.stop()); const before = globalThis.fetch;
  const transport = createEnvironmentFetch({ env: h.env, autoClose: true });
  const response = await transport.fetch('http://registry-fixture.invalid/package.tgz');
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.deepEqual(bytes, fixture.bytes); assert.doesNotThrow(() => verifyArchiveIntegrity(bytes, fixture.release.dist.integrity));
  assert.throws(() => verifyArchiveIntegrity(Buffer.concat([bytes, Buffer.from('changed')]), fixture.release.dist.integrity), /integrity/);
  assert.equal(h.count(), 1); await Promise.all(h.closed);
  const second = Buffer.from(await (await transport.fetch('http://registry-fixture.invalid/package-again.tgz')).arrayBuffer());
  assert.deepEqual(second, fixture.bytes); assert.equal(h.count(), 2); await Promise.all(h.closed); assert.equal(globalThis.fetch, before);
});
test('cancelled download closes its proxy lease and never returns a complete installable archive', async t => {
  const fixture = integrationFixture(); let reply: import('node:http').ServerResponse | undefined;
  const h = await route((_req, res) => { reply = res; res.writeHead(200, { 'content-length': String(fixture.bytes.length) }); res.write(fixture.bytes.subarray(0, 32)); });
  t.after(() => h.stop());
  const abort = new AbortController(), transport = createEnvironmentFetch({ env: h.env, autoClose: true });
  const response = await transport.fetch('http://registry-fixture.invalid/package.tgz', { signal: abort.signal }), reader = response.body!.getReader();
  const part = await reader.read(); assert.equal(part.value?.length, 32); abort.abort();
  await assert.rejects(reader.read()); await Promise.all(h.closed); assert.equal(reply?.destroyed, true);
  assert.throws(() => verifyArchiveIntegrity(Buffer.from(part.value!), fixture.release.dist.integrity), /integrity/);
});
test('neutral transport honors NO_PROXY and preserves an explicit custom fetch', async t => {
  const h = await route((_req, res) => res.end('direct')); t.after(() => h.stop());
  const direct = createEnvironmentFetch({ env: { ...h.env, NO_PROXY: '127.0.0.1' }, autoClose: true });
  assert.equal(await (await direct.fetch(`http://127.0.0.1:${(h.server.address() as any).port}`)).text(), 'direct'); assert.equal(h.count(), 0);
  let options: any;
  const custom = createEnvironmentFetch({ env: { HTTP_PROXY: 'socks5://irrelevant.invalid' }, autoClose: true, fetchRequest: async (_url, init) => { options = init; return new Response('explicit'); } });
  assert.equal(await (await custom.fetch('http://unused.invalid', { redirect: 'error' })).text(), 'explicit'); assert.equal(options.dispatcher, undefined); assert.equal(options.redirect, 'error');
});
