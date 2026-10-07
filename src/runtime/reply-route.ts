import type { AbortableOptions } from '../abort.js';
import type { PlatformAdapter } from '../types.js';

export type ReplyRoute = Pick<AbortableOptions, 'threadId' | 'replyToMessageId'>;

/** Bind a destination to a session; never use a bot-wide "last seen topic". */
export function bindReplyRoute<T extends PlatformAdapter>(adapter: T, route: ReplyRoute,
  onSent?: (messageId: string) => void): T {
  return new Proxy(adapter, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (typeof value !== 'function') return value;
      if (['send', 'sendCard', 'sendFile', 'sendVoice'].includes(String(property))) {
        return async (...args: unknown[]) => {
          args[2] = { ...route, ...(args[2] as object ?? {}) };
          const result = await value.apply(target, args);
          if (typeof result === 'string') onSent?.(result);
          return result;
        };
      }
      return value.bind(target);
    },
  });
}
