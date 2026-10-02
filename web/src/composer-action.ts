import type { WebComposerAction, WebSession } from '@chengzhiyi/pi-web-protocol';
import type { LoadedPlugin } from './plugin-manager.ts';

export type BoundComposerAction = (WebComposerAction & { pluginId?: string } | {
  kind: 'resume'; label: string; title: string; icon?: never; pluginId?: never;
}) & { sessionId: string };

/** Providers customize an empty composer or its existing running stop control. */
export function selectComposerAction(plugins: readonly LoadedPlugin[], session: (WebSession & { paused?: boolean }) | null, locale: 'zh' | 'en', draft: string, attachmentCount: number): BoundComposerAction | undefined {
  if (!session || (session.idle && (draft.trim() || attachmentCount))) return;
  for (const plugin of plugins) {
    const action = plugin.definition.composerAction?.(session, locale);
    if (!action || (session.idle ? action.kind !== 'invoke' : action.kind !== 'stop')) continue;
    return { ...action, pluginId: plugin.id, sessionId: session.sessionId };
  }
  if (!session.idle) return { kind: 'stop', sessionId: session.sessionId,
    label: locale === 'zh' ? '暂停执行' : 'Pause', title: locale === 'zh' ? '暂停当前执行，保留已有进度' : 'Pause execution and keep existing progress' };
  if (session.paused) return { kind: 'resume', sessionId: session.sessionId,
    label: locale === 'zh' ? '继续执行' : 'Continue', title: locale === 'zh' ? '基于已有进度继续执行' : 'Continue from existing progress' };
}

export async function executeComposerAction(action: BoundComposerAction,
  invoke: (pluginId: string, action: string, input?: unknown) => Promise<unknown>,
  send: (message: string) => Promise<void>, stop: () => Promise<void>, currentSessionId: () => string | null | undefined,
  resume?: () => Promise<void>): Promise<void> {
  if (currentSessionId() !== action.sessionId) throw new Error('Session changed');
  if (action.kind === 'stop') return stop();
  if (action.kind === 'resume') {
    if (!resume) throw new Error('Resume is unavailable');
    return resume();
  }
  if (!action.pluginId) throw new Error('Missing plugin for composer action');
  const result = await invoke(action.pluginId, action.action, action.input);
  if (currentSessionId() !== action.sessionId) throw new Error('Session changed');
  if (!action.sendResultMessage) return;
  const message = (result as { message?: unknown } | null)?.message;
  if (typeof message !== 'string' || !message.trim()) throw new Error('Plugin action did not return a message');
  await send(message);
}
