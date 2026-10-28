import assert from 'node:assert/strict';
import test from 'node:test';
import { HostedAgentAdapter } from '../src/host/server/plugins/hosted/agent-adapter.ts';
import { assessHostedSdk } from '../src/host/server/plugins/hosted/sdk-contract.ts';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

function api(hidden = true) {
  const tools = new Map<string, any>(); let active: string[] = [];
  return { on: () => () => {}, refreshTools() {}, registerTool(tool: any) { tools.set(tool.name, { ...tool, exposure: hidden ? tool.exposure : 'direct' }); },
    getAllTools: () => [...tools.values()], getActiveTools: () => active,
    setActiveTools(names: string[]) { active = names.filter(name => !hidden || tools.get(name)?.exposure !== 'hidden'); },
  } as unknown as ExtensionAPI;
}
test('SDK contract requires actual hidden exposure semantics, not a version string or method names alone', () => {
  assert.equal(assessHostedSdk(api()).supported, true);
  assert.equal(assessHostedSdk(api(false)).supported, false);
  assert.equal(assessHostedSdk({ on() {} } as unknown as ExtensionAPI).supported, false);
});
test('missing SDK tool permissions disables hosted tools without breaking base chat binding', async () => {
  const adapter = new HostedAgentAdapter({ policy: () => ({ enabled: true }), invoke: async () => { throw new Error('must not execute'); } });
  await adapter.verifyCompatibility();
  assert.doesNotThrow(() => adapter.mountTui({ on: () => () => {} } as unknown as ExtensionAPI, { cwd: '/fixture', workspaceId: 'w', sessionId: 's' }));
  assert.ok(adapter.compatibilityIssues.length);
  await adapter.freeze(20); adapter.change('fixture', []); adapter.thaw();
  await assert.rejects(adapter.invokeAction('fixture', { cwd: '/fixture', workspaceId: 'w', sessionId: 's' }, 'write', {}), /SDK.*capabilit/i);
});
test('settlement timeout releases admission instead of freezing unrelated chat forever', async () => {
  const handlers = new Map<string, any>(); const pi = api(); pi.on = ((name: string, handler: any) => { handlers.set(name, handler); return () => {}; }) as ExtensionAPI['on'];
  const adapter = new HostedAgentAdapter({ policy: () => ({ enabled: true }), invoke: async () => ({ content: [], details: undefined }) });
  await adapter.verifyCompatibility();
  adapter.mountTui(pi, { cwd: '/fixture', workspaceId: 'w', sessionId: 's' });
  await handlers.get('before_agent_start')();
  await assert.rejects(adapter.freeze(20), /settlement.*timed out/i);
  assert.equal(adapter.isFrozen, false); assert.doesNotThrow(() => adapter.assertAdmission());
});

test('real SDK with missing exposure contract keeps ordinary chat usable and refuses hosted execution', async () => {
  const { createAgentSession, DefaultResourceLoader, SessionManager } = await import('@earendil-works/pi-coding-agent');
  const { createAssistantMessageEventStream } = await import('@earendil-works/pi-ai');
  const { mkdtemp, rm } = await import('node:fs/promises'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const cwd = await mkdtemp(join(tmpdir(), 'sdk-capability-degrade-'));
  const manager = SessionManager.inMemory(cwd), scope = { cwd, workspaceId: 'fixture', sessionId: manager.getSessionId() };
  let calls = 0;
  const adapter = new HostedAgentAdapter({ policy: () => ({ enabled: true }), invoke: async () => { calls++; return { content: [], details: undefined }; } });
  const loader = new DefaultResourceLoader({ cwd, agentDir: join(cwd, 'agent'), noExtensions: true, noSkills: true, noPromptTemplates: true, extensionFactories: [pi => {
    const missing = new Proxy(pi, { get(target, property) { if (property === 'getAllTools') return () => target.getAllTools().map(({ exposure, ...tool }) => tool); return Reflect.get(target, property); } }) as ExtensionAPI;
    pi.on('session_start', () => { adapter.mountTui(missing, scope); });
  }] });
  await loader.reload(); const { session } = await createAgentSession({ cwd, sessionManager: manager, resourceLoader: loader });
  try {
    await adapter.verifyCompatibility();
    await session.bindExtensions({ mode: 'print' }); assert.ok(adapter.compatibilityIssues.length);
    await adapter.freeze(); adapter.change('fixture', [{ name: 'never_publish', label: 'Denied', description: 'Denied', action: 'write', parameters: { type: 'object', properties: {} } }]); adapter.thaw();
    assert.equal(session.getAllTools().some(tool => tool.name === 'never_publish'), false);
    const model = session.modelRuntime.getModels('openai')[0]!; await session.modelRuntime.setRuntimeApiKey('openai', 'fixture-not-a-key'); await session.setModel(model);
    session.agent.streamFunction = async model => {
      const message: import('@earendil-works/pi-ai').AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: [{ type: 'text', text: 'ordinary chat remains available' }], stopReason: 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream(); stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: 'stop', message }); stream.end(message); return stream;
    };
    await session.prompt('isolated deterministic plain chat'); assert.equal(session.isIdle, true); assert.equal(calls, 0);
    assert.ok(session.messages.some(message => message.role === 'assistant'));
    await assert.rejects(adapter.invokeAction('fixture', scope, 'write', {}), /SDK.*capabilit/i);
  } finally { session.dispose(); await rm(cwd, { recursive: true, force: true }); }
});
