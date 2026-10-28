import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import { createModelFetch, modelNetworkDiagnostic } from '../bin/model-network.mjs';

test('model diagnostics preserve bounded causes/codes and omit URLs, credentials, prompts and filesystem paths', () => {
  const error = Object.assign(new TypeError('fetch failed https://private/token=secret /private/customer'), { cause: Object.assign(new Error('secret prompt'), { code: 'UND_ERR_CONNECT_TIMEOUT', cause: Object.assign(new Error('private'), { code: 'ETIMEDOUT' }) }) });
  const diagnostic = modelNetworkDiagnostic(error, { requestId: 'request-fixture', stage: 'model_headers' });
  assert.equal(diagnostic.kind, 'timeout'); assert.equal(diagnostic.causes[1]?.code, 'UND_ERR_CONNECT_TIMEOUT');
  assert.equal(diagnostic.requestId, 'request-fixture');
  assert.ok(!JSON.stringify(diagnostic).match(/secret|private|customer|https:/));
  assert.equal(modelNetworkDiagnostic(Object.assign(new Error('TLS'), { code: 'CERT_HAS_EXPIRED' }), { stage: 'model_headers' }).kind, 'tls');
  assert.equal(modelNetworkDiagnostic(Object.assign(new Error('SDK frozen'), { code: 'agent_settlement_timeout' }), { stage: 'model_admission' }).kind, 'lifecycle');
});
test('actual fetch uses explicit environment proxy and honors NO_PROXY without changing global fetch', async t => {
  const upstream = createServer((_req, res) => res.end('local-model-response')); upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const upstreamPort = (upstream.address() as any).port; let tunnels = 0;
  const proxy = createServer(); proxy.on('connect', (req, socket, head) => { tunnels++; const remote = connect(upstreamPort, '127.0.0.1', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) remote.write(head); socket.pipe(remote); remote.pipe(socket); }); remote.on('error', () => socket.destroy()); socket.on('error', () => remote.destroy()); });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  const original = globalThis.fetch;
  const env = { HTTP_PROXY: `http://127.0.0.1:${(proxy.address() as any).port}`, NO_PROXY: '' };
  const request = createModelFetch({ env });
  t.after(async () => { await request.close(); proxy.closeAllConnections(); upstream.closeAllConnections(); proxy.close(); upstream.close(); });
  assert.equal(await (await request.fetch('http://model-does-not-resolve.invalid/response')).text(), 'local-model-response'); assert.equal(tunnels, 1);
  const direct = createModelFetch({ env: { ...env, NO_PROXY: '127.0.0.1' } });
  t.after(() => direct.close());
  assert.equal(await (await direct.fetch(`http://127.0.0.1:${upstreamPort}/response`)).text(), 'local-model-response'); assert.equal(tunnels, 1);
  assert.equal(globalThis.fetch, original);
});
test('connection errors are diagnosed independently of hosted plugin admission', async () => {
  const diagnostics: any[] = [];
  const request = createModelFetch({ env: { HTTP_PROXY: 'http://127.0.0.1:1', NO_PROXY: '' }, onDiagnostic: d => diagnostics.push(d) });
  try { await assert.rejects(request.fetch('http://model-does-not-resolve.invalid/response')); assert.equal(diagnostics.length, 1); assert.equal(diagnostics[0].kind, 'proxy'); assert.equal(diagnostics[0].stage, 'model_headers'); assert.ok(diagnostics[0].requestId); }
  finally { await request.close(); }
});

test('owned Pi child preload reaches the actual local proxy before SDK load; parent transport stays untouched', async t => {
  const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util');
  const server = createServer((_req, res) => res.end('owned-child-model-route')); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  let tunnels = 0;
  const proxy = createServer(); proxy.on('connect', (_req, socket, head) => { tunnels++; const remote = connect((server.address() as any).port, '127.0.0.1', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) remote.write(head); socket.pipe(remote); remote.pipe(socket); }); remote.on('error', () => socket.destroy()); socket.on('error', () => remote.destroy()); });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  t.after(() => { proxy.closeAllConnections(); proxy.close(); server.closeAllConnections(); server.close(); });
  const before = globalThis.fetch;
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', new URL('../bin/model-network-bootstrap.mjs', import.meta.url).href, '--input-type=module', '-e', "console.log(await (await fetch('http://model-does-not-resolve.invalid/response')).text())"], { timeout: 10000, env: { ...process.env, PI_WEBAPP_LAUNCHER_NONCE: 'isolated-test-child', HTTP_PROXY: `http://127.0.0.1:${(proxy.address() as any).port}`, http_proxy: `http://127.0.0.1:${(proxy.address() as any).port}`, HTTPS_PROXY: '', https_proxy: '', NO_PROXY: '', no_proxy: '' } });
  assert.equal(stdout.trim(), 'owned-child-model-route'); assert.equal(tunnels, 1); assert.equal(globalThis.fetch, before);
});

test('real response-body disconnect is identified as streaming failure without claiming a plugin block', async t => {
  let reply: import('node:http').ServerResponse | undefined;
  const server = createServer((_req, res) => { reply = res; res.writeHead(200, { 'content-type': 'text/event-stream', 'content-length': '1000' }); res.flushHeaders(); res.write('data: partial\n\n'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const diagnostics: any[] = [];
  const transport = createModelFetch({ env: {}, onDiagnostic: value => diagnostics.push(value) });
  t.after(async () => { await transport.close(); server.closeAllConnections(); server.close(); });
  const response = await transport.fetch(`http://127.0.0.1:${(server.address() as any).port}/stream`), reader = response.body!.getReader();
  assert.equal((await reader.read()).done, false); reply!.destroy();
  await assert.rejects(reader.read());
  assert.ok(diagnostics.some(d => d.stage === 'model_stream' && d.kind === 'interrupted'));
});
test('NO_PROXY failures and invalid proxy configuration retain accurate, credential-free categories', async () => {
  const diagnostics: any[] = [];
  const direct = createModelFetch({ env: { HTTP_PROXY: 'http://127.0.0.1:2', NO_PROXY: '127.0.0.1' }, onDiagnostic: value => diagnostics.push(value) });
  try { await assert.rejects(direct.fetch('http://127.0.0.1:1/model')); assert.equal(diagnostics[0].proxied, false); assert.equal(diagnostics[0].kind, 'network'); } finally { await direct.close(); }
  const invalid = createModelFetch({ env: { HTTP_PROXY: 'socks5://private-user:private-password@private-proxy:1234' }, onDiagnostic: value => diagnostics.push(value) });
  try { await assert.rejects(invalid.fetch('http://example.invalid'), /configuration is invalid or unsupported/); assert.equal(diagnostics.at(-1).kind, 'proxy'); assert.ok(!JSON.stringify(diagnostics).includes('private')); } finally { await invalid.close(); }
});

test('an explicit custom fetch keeps control of its transport and receives no dispatcher injection', async () => {
  let init: RequestInit | undefined;
  const custom = async (_input: string | URL | Request, next?: RequestInit) => { init = next; return new Response('custom-provider-route'); };
  const transport = createModelFetch({ env: { HTTP_PROXY: 'socks5://unused.invalid' }, fetchRequest: custom });
  try { assert.equal(await (await transport.fetch('http://unused.invalid', { method: 'POST' })).text(), 'custom-provider-route'); assert.equal(init?.method, 'POST'); assert.equal((init as any)?.dispatcher, undefined); } finally { await transport.close(); }
});
