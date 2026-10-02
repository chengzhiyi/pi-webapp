import assert from 'node:assert/strict';
import test from 'node:test';
import { buildComposerCommands, resolveComposerCommand, filterComposerCommands } from '../web/src/composer-commands.ts';

const plugins = [{ id: 'plan-plugin', definition: { id: 'plan-plugin', apiVersion: 1 as const, activate() {}, commands: [{
  id: 'plan', title: 'Plan mode', action: 'plan.command',
  presentation: { label: { zh: '计划', en: 'Plan' }, description: { zh: '进入或退出计划模式', en: 'Enter or leave plan mode' }, section: 'add' as const },
  input: { token: { zh: '计划', en: 'plan' }, hint: { zh: '描述你的任务以生成计划', en: 'Describe your task to generate a plan' }, attachments: true },
}] } }];

test('plugin presentation replaces the matching Pi command without losing its action', () => {
  const commands = buildComposerCommands([{ name: 'compact', label: '压缩' }], [{ name: 'plan', description: 'English SDK description' }], plugins, 'zh');
  assert.equal(commands.filter(c => c.name === 'plan').length, 1);
  assert.equal(commands[0].label, '计划');
  assert.equal(commands[0].section, 'add');
  assert.equal(commands[0].pluginId, 'plan-plugin');
  assert.equal(commands[0].action, 'plan.command');
  assert.equal(commands[0].description, '进入或退出计划模式');
});

test('localized and canonical spellings route to the same plugin while preserving the task', () => {
  const commands = buildComposerCommands([], [], plugins, 'en');
  const task = '设计  用户登录\n保留错误日志';
  for (const token of ['/计划', '/plan']) {
    const match = resolveComposerCommand(`${token} ${task}`, commands);
    assert.equal(match?.command.action, 'plan.command');
    assert.equal(match?.text, task);
    assert.equal(match?.token, token);
  }
  assert.equal(resolveComposerCommand('/planish task', commands), undefined);
  assert.equal(resolveComposerCommand('写一个 /plan task', commands), undefined);
  assert.equal(resolveComposerCommand('/计划 task', []), undefined);
});

test('menu searches both localized labels and aliases and excludes immediate menu actions from slash input', () => {
  const commands = buildComposerCommands([{ name: 'file', menuOnly: true, section: 'add' }], [], plugins, 'zh');
  assert.equal(filterComposerCommands(commands, 'plan', true)[0].label, '计划');
  assert.equal(filterComposerCommands(commands, '计', true)[0].name, 'plan');
  assert.equal(filterComposerCommands(commands, '', true).some(c => c.name === 'file'), false);
  assert.equal(filterComposerCommands(commands, '', false)[0].name, 'file');
});
