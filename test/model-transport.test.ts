import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceSessions } from '../src/host/server/sessions/workspace-sessions.ts';

test('real SDK model HTTP failure retains transport diagnosis and correlation independently of plugins', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-model-transport-'));
  const before = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
  let requests = 0;
  const server = createServer((_req, res) => { requests++; res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'local fixture unavailable', type: 'server_error' } })); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const published: any[] = [], captured: any[] = [];
  const workspaces = new WorkspaceSessions(event => published.push(event), () => undefined, () => false, (_error, fields) => { captured.push(fields); return 'network-diagnostic-fixture'; });
  try {
    await workspaces.open(root, 'new'); const session = workspaces.session!;
    session.settingsManager.setRetryEnabled(false);
    const model = session.modelRuntime.getModels('openai').find(m => m.api === 'openai-responses')!;
    await session.modelRuntime.setRuntimeApiKey('openai', 'fixture-not-a-real-key');
    await session.setModel({ ...model, baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1` });
    session.agent.transport = 'sse';
    await workspaces.send('isolated fixture prompt', [], { operationId: 'model-operation-fixture', requestId: 'logical-request-fixture' });
    for (let i = 0; i < 500 && !session.isIdle; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(requests > 0, 'actual SDK sent a request to the isolated HTTP server');
    assert.ok(captured.some(c => c.networkKind === 'server' && c.networkStage === 'model_headers' && c.operationId === 'model-operation-fixture' && c.requestId !== 'logical-request-fixture'));
    assert.ok(published.some(e => e.type === 'error' && e.errorId === 'network-diagnostic-fixture'));
    assert.equal(session.isIdle, true);
  } finally {
    await workspaces.dispose(); server.closeAllConnections(); server.close();
    if (before === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = before;
    await rm(root, { recursive: true, force: true });
  }
});

test('actual frozen adapter rejects send with correlated lifecycle diagnosis and zero model HTTP requests', async () => {
  const { HostedAgentAdapter } = await import('../src/host/server/plugins/hosted/agent-adapter.ts');
  const root = await mkdtemp(join(tmpdir(), 'pi-model-admission-'));
  const before = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
  let requests = 0;
  const server = createServer((_req, res) => { requests++; res.writeHead(503); res.end(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const captured: any[] = [];
  const adapter = new HostedAgentAdapter({ policy: () => ({ enabled: false }), invoke: async () => { throw new Error('No plugin invocation expected'); } });
  const workspaces = new WorkspaceSessions(() => {}, () => undefined, () => false, (_error, fields) => { captured.push(fields); return 'admission-diagnostic-fixture'; }, undefined, undefined, [], {
    adapter, scope: (cwd, sessionId) => ({ cwd, sessionId, workspaceId: 'isolated' }),
  });
  try {
    await workspaces.open(root, 'new'); const session = workspaces.session!;
    const model = session.modelRuntime.getModels('openai').find(m => m.api === 'openai-responses')!;
    await session.modelRuntime.setRuntimeApiKey('openai', 'fixture-not-a-real-key');
    await session.setModel({ ...model, baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1` });
    await adapter.freeze();
    await assert.rejects(workspaces.send('must never become a model request', [], { operationId: 'admission-operation', requestId: 'admission-request' }), (error: any) => error.code === 'hosted_admission_blocked');
    assert.equal(requests, 0);
    assert.ok(captured.some(detail => detail.networkKind === 'lifecycle' && detail.networkStage === 'model_admission' && detail.requestId === 'admission-request' && detail.operationId === 'admission-operation' && detail.causeCodes === 'hosted_admission_blocked'));
    assert.equal(session.isIdle, true);
    adapter.thaw(); assert.doesNotThrow(() => adapter.assertAdmission());
  } finally {
    adapter.thaw(); await workspaces.dispose(); server.closeAllConnections(); server.close();
    if (before === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = before;
    await rm(root, { recursive: true, force: true });
  }
});
