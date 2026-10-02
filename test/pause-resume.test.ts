import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { PAUSED_ENTRY, sessionPaused, projectSession } from '../extension/view.ts';
import { WorkspaceSessions } from '../extension/workspace-sessions.ts';
import { selectComposerAction, executeComposerAction } from '../web/src/composer-action.ts';
import { conversationTurns } from '../web/src/conversation-turns.ts';

test('pause markers belong to the current branch and survive tool cancellation and reopening', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-pause-branch-'));
  try {
    const manager = SessionManager.create(root);
    const first = manager.appendMessage({ role: 'user', content: 'Work', timestamp: Date.now() });
    manager.appendCustomEntry(PAUSED_ENTRY);
    manager.appendMessage({ role: 'toolResult', toolCallId: 'call', toolName: 'bash', content: [{ type: 'text', text: 'Cancelled' }], isError: true, timestamp: Date.now() });
    assert.equal(sessionPaused(manager.getBranch()), true);
    // A user message is what makes Pi flush a new session file to disk.
    manager.appendMessage({ role: 'assistant', content: [], api: 'openai-responses', provider: 'test', model: 'test', stopReason: 'aborted', timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    assert.equal(sessionPaused(SessionManager.open(manager.getSessionFile()!).getBranch()), true);
    manager.appendMessage({ role: 'user', content: 'New request', timestamp: Date.now() });
    assert.equal(sessionPaused(manager.getBranch()), false);
    manager.branch(first);
    assert.equal(sessionPaused(manager.getBranch()), false);
    const ctx = { sessionManager: manager, cwd: root, isIdle: () => true, getContextUsage: () => undefined };
    assert.equal(projectSession(ctx as unknown as Parameters<typeof projectSession>[0]).paused, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('ordinary SDK chat pauses, restores, and continues without a plan plugin or network', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-pause-sdk-'));
  const savedAgent = process.env.PI_CODING_AGENT_DIR;
  const savedPlugins = process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS;
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
  process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS = '';
  const cwd = join(root, 'workspace');
  await mkdir(cwd);
  const host = new WorkspaceSessions(() => {}, () => undefined);
  try {
    await host.open(cwd, 'new');
    const agentSession = host.session!;
    const model = agentSession.modelRuntime.getModels('openai')[0]!;
    await agentSession.modelRuntime.setRuntimeApiKey('openai', 'fixture-no-network');
    await agentSession.setModel(model);
    let started!: () => void;
    const start = new Promise<void>(resolve => { started = resolve; });
    agentSession.agent.streamFunction = async (model, _context, options) => {
      const message = { role: 'assistant' as const, api: model.api, provider: model.provider, model: model.id, content: [{ type: 'text' as const, text: 'Partial progress' }], stopReason: 'aborted' as const, timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const aborted = new Promise<void>(resolve => {
        if (options?.signal?.aborted) resolve();
        else options?.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      const stream = createAssistantMessageEventStream();
      started();
      void aborted.then(() => { stream.push({ type: 'error', reason: 'aborted', error: message }); stream.end(message); });
      return stream;
    };
    await host.send('Finish the task');
    await start;
    assert.equal(host.snapshot().idle, false);
    const pause = selectComposerAction([], host.snapshot(), 'en', '', 0)!;
    await executeComposerAction(pause, async () => { throw new Error('no plugin'); }, async () => {}, () => host.stop(), () => host.snapshot().sessionId);
    assert.equal(host.snapshot().idle, true);
    assert.equal(host.snapshot().paused, true);
    const file = agentSession.sessionManager.getSessionFile()!;
    await host.open(cwd, 'new');
    assert.equal(selectComposerAction([], host.snapshot(), 'en', '', 0), undefined);
    await host.open(cwd, { sessionFile: file });
    assert.equal(host.snapshot().paused, true);
    const restored = host.session!;
    await restored.modelRuntime.setRuntimeApiKey('openai', 'fixture-no-network');
    await restored.setModel(model);
    const requested: string[] = [];
    restored.agent.streamFunction = async (model, context) => {
      requested.push(JSON.stringify(context.messages));
      const message = { role: 'assistant' as const, api: model.api, provider: model.provider, model: model.id, content: [{ type: 'text' as const, text: 'Finished remaining work' }], stopReason: 'stop' as const, timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'done', reason: 'stop', message }); stream.end(message);
      return stream;
    };
    const resume = selectComposerAction([], host.snapshot(), 'en', '', 0)!;
    const usersBeforeResume = host.snapshot().messages.filter(message => message.role === 'user').map(message => message.id);
    await executeComposerAction(resume, async () => { throw new Error('no plugin'); }, async () => { throw new Error('must not send a user message'); }, () => host.stop(), () => host.snapshot().sessionId, () => host.resume());
    await restored.waitForIdle();
    assert.equal(requested.length, 1);
    assert.match(requested[0]!, /Finish the task/);
    assert.match(requested[0]!, /interrupted/);
    assert.match(requested[0]!, /Partial progress/);
    assert.deepEqual(host.snapshot().messages.filter(message => message.role === 'user').map(message => message.id), usersBeforeResume);
    assert.equal(conversationTurns(host.snapshot().messages).length, 1, 'continuation stays in the original user turn');
    assert.ok(restored.sessionManager.getBranch().some(entry => entry.type === 'custom_message' && entry.customType === 'pi-webapp/resume' && entry.display === false));
    assert.equal(host.snapshot().paused, false);
    assert.equal(selectComposerAction([], host.snapshot(), 'en', '', 0), undefined);
    await assert.rejects(host.resume(), /没有暂停的任务/);

    // Cancellation between a tool call and its result has no aborted assistant.
    let toolStarted!: () => void;
    const toolReady = new Promise<void>(resolve => { toolStarted = resolve; });
    const off = restored.subscribe(event => { if (event.type === 'tool_execution_start') toolStarted(); });
    let toolRequests = 0;
    restored.agent.streamFunction = async (model, _context, options) => {
      const cancelled = options?.signal?.aborted;
      const first = toolRequests++ === 0;
      const message: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
        content: first ? [{ type: 'toolCall', id: 'waiting-tool', name: 'bash', arguments: { command: 'sleep 30' } }] : [], stopReason: cancelled ? 'aborted' : first ? 'toolUse' : 'stop', timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
      if (cancelled) stream.push({ type: 'error', reason: 'aborted', error: message });
      else stream.push({ type: 'done', reason: first ? 'toolUse' : 'stop', message });
      stream.end(message);
      return stream;
    };
    await host.send('Run a tool');
    await Promise.race([toolReady, new Promise((_, reject) => setTimeout(() => reject(new Error('Tool did not start')), 1000))]);
    await host.stop();
    off();
    assert.equal(host.snapshot().idle, true);
    assert.equal(host.snapshot().paused, true);
    assert.ok(host.snapshot().messages.some(message => message.role === 'tool' && message.toolCallId === 'waiting-tool'));
    assert.equal(sessionPaused(SessionManager.open(restored.sessionManager.getSessionFile()!).getBranch()), true);
  } finally {
    await host.dispose();
    if (savedAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgent;
    if (savedPlugins === undefined) delete process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS; else process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS = savedPlugins;
    await rm(root, { recursive: true, force: true });
  }
});
