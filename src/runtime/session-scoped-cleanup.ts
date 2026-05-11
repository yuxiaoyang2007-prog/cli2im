import type { SessionKey } from '../types.js';
import type { TelegramStreamController } from '../platforms/telegram/stream.js';

export interface SessionScopedBufferDeps {
  voiceSessions: Map<SessionKey, string>;
  tgStreamController?: Pick<TelegramStreamController, 'interrupt'>;
}

export interface VoiceSessionCommitDeps {
  voiceSessions: Map<SessionKey, string>;
  hasProcess: (sessionKey: SessionKey) => boolean;
  getContextSignal?: (sessionKey: SessionKey) => AbortSignal | undefined;
}

const abortBindings = new WeakMap<AbortSignal, Set<SessionKey>>();

export function clearSessionScopedBuffers(
  sessionKey: SessionKey,
  deps: SessionScopedBufferDeps,
): void {
  deps.voiceSessions.delete(sessionKey);
  deps.tgStreamController?.interrupt(sessionKey);
}

export function bindSessionScopedBufferCleanup(
  signal: AbortSignal,
  sessionKey: SessionKey,
  deps: SessionScopedBufferDeps,
): void {
  if (signal.aborted) {
    clearSessionScopedBuffers(sessionKey, deps);
    return;
  }

  let boundSessions = abortBindings.get(signal);
  if (!boundSessions) {
    boundSessions = new Set();
    abortBindings.set(signal, boundSessions);
  }
  if (boundSessions.has(sessionKey)) return;
  boundSessions.add(sessionKey);

  signal.addEventListener('abort', () => {
    boundSessions.delete(sessionKey);
    clearSessionScopedBuffers(sessionKey, deps);
  }, { once: true });
}

export function commitVoiceSessionWhenContextReady(
  sessionKey: SessionKey,
  chatId: string,
  deps: VoiceSessionCommitDeps,
): boolean {
  if (!deps.hasProcess(sessionKey)) {
    deps.voiceSessions.delete(sessionKey);
    return false;
  }

  if (deps.getContextSignal?.(sessionKey)?.aborted) {
    deps.voiceSessions.delete(sessionKey);
    return false;
  }

  deps.voiceSessions.set(sessionKey, chatId);
  return true;
}
