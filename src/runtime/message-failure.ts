import { QueueCancelledError } from '../session/queue.js';
import type { SessionStore } from '../session/store.js';
import { buildSessionKey, type InboundMessage, type PlatformAdapter, type SessionKey } from '../types.js';
import type { TaskTracker } from './task-tracker.js';

export async function reportMessageFailure(
  error: unknown,
  sessionKey: SessionKey,
  msg: InboundMessage,
  deps: { busyTasks: TaskTracker; store: Pick<SessionStore, 'getPreferences' | 'updatePreferences'>; adapter: PlatformAdapter },
): Promise<void> {
  const cancellation = deps.busyTasks.cancel(sessionKey);
  if (error instanceof QueueCancelledError) {
    if ((await deps.store.getPreferences(sessionKey).catch(() => undefined))?.taskState === 'running')
      await deps.store.updatePreferences(sessionKey, { taskState: 'interrupted', taskUpdatedAt: Date.now() }, cancellation.isCurrent).catch(() => {});
    return;
  }
  console.error('[pipeline] message_processing_failed');
  await deps.store.updatePreferences(sessionKey, { taskState: 'failed', taskUpdatedAt: Date.now() }, cancellation.isCurrent).catch(() => {});
  if (!cancellation.isCurrent()) return;
  await deps.adapter.send(msg.chatId, { text: '任务未完成，请查看 /status；程序没有自动重跑。' }).catch(() => {});
}

/** Shared execution boundary: a batched message or relay reports failure once. */
export function withMessageFailureCleanup(
  botName: string,
  handler: (msg: InboundMessage) => Promise<void>,
  reportFailure: (error: unknown, key: string, msg: InboundMessage) => Promise<void>,
): (msg: InboundMessage) => Promise<void> {
  return async msg => {
    try {
      await handler(msg);
    } catch (error) {
      await reportFailure(error, buildSessionKey(msg.platform, msg.chatId, botName, msg.threadId), msg);
    }
  };
}
