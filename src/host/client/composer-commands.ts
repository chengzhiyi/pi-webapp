import type { ComponentType } from 'react';
import type { WebCommandInput, WebLocalizedText, WebPluginDefinition } from '@chengzhiyi/pi-web-protocol';
import type { CommandOption } from './pi-bridge.ts';

export interface ComposerCommand extends CommandOption {
  label?: string;
  icon?: ComponentType<{ size?: number; className?: string }>;
  section?: 'add' | 'commands';
  pluginId?: string;
  action?: string;
  menuOnly?: boolean;
  input?: WebCommandInput;
}
export function commandText(text: WebLocalizedText | undefined, locale: 'zh' | 'en'): string | undefined {
  return typeof text === 'string' ? text : text?.[locale];
}

/** Browser contributions supply the presentation for their matching Pi command. */
export function buildComposerCommands(builtins: readonly ComposerCommand[], catalog: readonly CommandOption[], plugins: readonly { id: string; definition: WebPluginDefinition }[], locale: 'zh' | 'en'): ComposerCommand[] {
  const unique = new Map<string, ComposerCommand>();
  for (const command of [...builtins, ...catalog.map(command => ({ ...command, section: 'commands' as const }))]) if (!unique.has(command.name)) unique.set(command.name, { ...command, section: command.section ?? 'commands' });
  for (const plugin of plugins) {
    for (const command of plugin.definition.commands ?? []) {
      unique.set(command.id, { name: command.id, label: commandText(command.presentation?.label, locale) ?? command.title,
        description: commandText(command.presentation?.description, locale) ?? command.description,
        icon: command.presentation?.icon, section: command.presentation?.section ?? 'commands', input: command.input,
        pluginId: plugin.id, action: command.action });
    }
    for (const item of plugin.definition.menuItems ?? []) if (item.menu === 'composer') {
      unique.set(`${plugin.id}:${item.id}`, { name: item.title, label: item.title, section: 'add', pluginId: plugin.id, action: item.action, menuOnly: true });
    }
  }
  return [...unique.values()].sort((a, b) => Number(b.section === 'add') - Number(a.section === 'add'));
}
function aliases(command: ComposerCommand): string[] {
  const token = command.input?.token;
  return [command.name, ...(typeof token === 'string' ? [token] : token ? [token.zh, token.en] : [])];
}
export function resolveComposerCommand(draft: string, commands: readonly ComposerCommand[]): { command: ComposerCommand; token: string; text: string } | undefined {
  const match = /^\/(\S+)(?:\s([\s\S]*))?$/.exec(draft.trimStart());
  if (!match) return;
  const command = commands.find(c => !c.menuOnly && c.name === match[1]) ?? commands.find(c => !c.menuOnly && aliases(c).includes(match[1]));
  return command ? { command, token: `/${match[1]}`, text: (match[2] ?? '').trim() } : undefined;
}
export function filterComposerCommands(commands: readonly ComposerCommand[], query: string, slash: boolean): ComposerCommand[] {
  const search = query.toLocaleLowerCase();
  return commands.filter(c => (!slash || !c.menuOnly) && [...aliases(c), c.label ?? ''].some(name => name.toLocaleLowerCase().includes(search)));
}
