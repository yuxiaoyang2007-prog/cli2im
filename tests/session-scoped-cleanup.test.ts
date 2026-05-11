import { describe, expect, it, vi } from 'vitest';
import {
  bindSessionScopedBufferCleanup,
  commitVoiceSessionWhenContextReady,
  clearSessionScopedBuffers,
} from '../src/runtime/session-scoped-cleanup.js';
import type { SessionKey } from '../src/types.js';

const sessionKey = 'telegram:chat_1:ccbot' as SessionKey;

describe('session-scoped buffer cleanup', () => {
  it('clears voice session state when the owning context aborts', () => {
    const controller = new AbortController();
    const voiceSessions = new Map<SessionKey, string>([[sessionKey, 'chat_1']]);
    const tgStreamController = { interrupt: vi.fn() };

    bindSessionScopedBufferCleanup(controller.signal, sessionKey, {
      voiceSessions,
      tgStreamController,
    });
    controller.abort();

    expect(voiceSessions.has(sessionKey)).toBe(false);
    expect(tgStreamController.interrupt).toHaveBeenCalledWith(sessionKey);
  });

  it('clears explicit lifecycle command buffers', () => {
    const voiceSessions = new Map<SessionKey, string>([[sessionKey, 'chat_1']]);
    const tgStreamController = { interrupt: vi.fn() };

    clearSessionScopedBuffers(sessionKey, { voiceSessions, tgStreamController });

    expect(voiceSessions.has(sessionKey)).toBe(false);
    expect(tgStreamController.interrupt).toHaveBeenCalledWith(sessionKey);
  });

  it('does not retain a transcribed voice session before an agent context exists', () => {
    const voiceSessions = new Map<SessionKey, string>([[sessionKey, 'stale_chat']]);

    const committed = commitVoiceSessionWhenContextReady(sessionKey, 'chat_1', {
      voiceSessions,
      hasProcess: () => false,
    });

    expect(committed).toBe(false);
    expect(voiceSessions.has(sessionKey)).toBe(false);
  });

  it('does not retain a transcribed voice session for an aborted agent context', () => {
    const controller = new AbortController();
    controller.abort();
    const voiceSessions = new Map<SessionKey, string>([[sessionKey, 'stale_chat']]);

    const committed = commitVoiceSessionWhenContextReady(sessionKey, 'chat_1', {
      voiceSessions,
      hasProcess: () => true,
      getContextSignal: () => controller.signal,
    });

    expect(committed).toBe(false);
    expect(voiceSessions.has(sessionKey)).toBe(false);
  });
});
