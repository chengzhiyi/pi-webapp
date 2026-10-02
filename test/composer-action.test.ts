import assert from 'node:assert/strict';
import test from 'node:test';
import { selectComposerAction, executeComposerAction } from '../web/src/composer-action.ts';

const session = { sessionId: 'current', idle: true, pluginEntries: [] };
const contribution = { kind: 'invoke' as const, label: '继续执行计划', action: 'plan.resubmit', input: { callId: 'interrupted' }, sendResultMessage: true };
const plugins = [{ id: 'plan', definition: { id: 'plan', apiVersion: 1 as const, activate() {}, composerAction: () => contribution } }];

test('the empty idle composer offers a session-bound resume action', () => {
  const action = selectComposerAction(plugins, session, 'zh', '', 0);
  assert.equal(action?.label, '继续执行计划');
  assert.equal(action?.pluginId, 'plan');
  assert.equal(action?.sessionId, 'current');
});

test('drafts and attachments keep the normal send action', () => {
  assert.equal(selectComposerAction(plugins, session, 'zh', '需要修改方案', 0), undefined);
  assert.equal(selectComposerAction(plugins, session, 'zh', '', 1), undefined);
});

test('a running execution offers pause even when a draft is present', () => {
  const stop = [{ id: 'plan', definition: { id: 'plan', apiVersion: 1 as const, activate() {}, composerAction: () => ({ kind: 'stop' as const, label: '暂停执行' }) } }];
  assert.equal(selectComposerAction(stop, { ...session, idle: false }, 'zh', '保留草稿', 1)?.label, '暂停执行');
  assert.equal(selectComposerAction(plugins, { ...session, idle: false }, 'zh', '', 0)?.kind, 'stop');
  assert.equal(selectComposerAction(stop, session, 'zh', '', 0), undefined);
  assert.equal(selectComposerAction(plugins, null, 'zh', '', 0), undefined);
});

test('resume sends the new request only after the action succeeds', async () => {
  const action = selectComposerAction(plugins, session, 'zh', '', 0)!;
  const sent: string[] = [];
  await executeComposerAction(action, async (plugin, name, input) => {
    assert.equal(plugin, 'plan'); assert.equal(name, 'plan.resubmit'); assert.deepEqual(input, { callId: 'interrupted' });
    assert.deepEqual(sent, []);
    return { message: '检查已有进度并提交新版本审批' };
  }, async message => { sent.push(message); }, async () => {}, () => 'current');
  assert.deepEqual(sent, ['检查已有进度并提交新版本审批']);
});

test('failed or malformed actions never send a generated resume request', async () => {
  const action = selectComposerAction(plugins, session, 'zh', '', 0)!;
  let sent = 0;
  for (const invoke of [async () => { throw new Error('old backend'); }, async () => ({ message: 3 })]) {
    await assert.rejects(executeComposerAction(action, invoke, async () => { sent++; }, async () => {}, () => 'current'));
  }
  assert.equal(sent, 0);
});

test('session changes between invoke and send cannot resume a different session', async () => {
  const action = selectComposerAction(plugins, session, 'zh', '', 0)!;
  let current = 'current'; let sent = 0;
  await assert.rejects(executeComposerAction(action, async () => { current = 'other'; return { message: 'stale plan' }; },
    async () => { sent++; }, async () => {}, () => current), /Session changed/);
  assert.equal(sent, 0);
});

test('pause uses the existing abort boundary without invoking a plugin action', async () => {
  let stopped = 0;
  await executeComposerAction({ pluginId: 'plan', sessionId: 'current', kind: 'stop', label: '暂停执行' },
    async () => { throw new Error('must not invoke'); }, async () => { throw new Error('must not send'); },
    async () => { stopped++; }, () => 'current');
  assert.equal(stopped, 1);
});

test('ordinary chats offer pause without any plugin, even with a draft', () => {
  const action = selectComposerAction([], { ...session, idle: false }, 'zh', '保留草稿', 1);
  assert.equal(action?.kind, 'stop');
  assert.equal(action?.label, '暂停执行');
});

test('a paused ordinary chat offers a session-bound continuation in either locale', async () => {
  const paused = { ...session, paused: true };
  const action = selectComposerAction([], paused, 'zh', '', 0)!;
  assert.equal(action?.kind, 'resume');
  assert.equal(action?.label, '继续执行');
  let resumed = 0;
  await executeComposerAction(action, async () => { throw new Error('no plugin'); },
    async () => { throw new Error('must not send a user message'); }, async () => { throw new Error('must not abort'); }, () => 'current', async () => { resumed++; });
  assert.equal(resumed, 1);
  assert.equal(selectComposerAction([], paused, 'en', '', 0)?.label, 'Continue');
  assert.equal(selectComposerAction([], paused, 'zh', '新要求', 0), undefined);
  assert.equal(selectComposerAction([], paused, 'zh', '', 1), undefined);
  assert.equal(selectComposerAction([], session, 'zh', '', 0), undefined);
});

test('plugin approval-aware continuation takes precedence over the generic one', () => {
  assert.equal(selectComposerAction(plugins, { ...session, paused: true }, 'zh', '', 0)?.pluginId, 'plan');
});

test('ordinary continuation refuses a different session and propagates resume failure', async () => {
  const action = selectComposerAction([], { ...session, paused: true }, 'en', '', 0)!;
  let sends = 0;
  await assert.rejects(executeComposerAction(action, async () => {}, async () => { sends++; }, async () => {}, () => 'other'), /Session changed/);
  assert.equal(sends, 0);
  await assert.rejects(executeComposerAction(action, async () => {}, async () => { throw new Error('must not send'); }, async () => {}, () => 'current', async () => { throw new Error('offline'); }), /offline/);
});
