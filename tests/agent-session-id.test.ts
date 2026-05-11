import { describe, expect, it, vi } from 'vitest';
import { persistAgentSessionIdIfCurrent } from '../src/runtime/agent-session-id.js';
import type { Session, SessionKey } from '../src/types.js';

describe('persistAgentSessionIdIfCurrent', () => {
  it('skips the store update when the process context becomes stale while awaiting the session lookup', async () => {
    const lookupGate = deferred<Session | null>();
    const store = {
      getByKey: vi.fn().mockReturnValue(lookupGate.promise),
      updateAgentSessionId: vi.fn().mockResolvedValue(undefined),
    };
    const isCurrent = vi.fn().mockReturnValue(true);
    const sessionKey = 'telegram:chat_1:ccbot' as SessionKey;

    const persist = persistAgentSessionIdIfCurrent(
      store,
      sessionKey,
      'agent-session-old',
      isCurrent,
    );
    isCurrent.mockReturnValue(false);
    lookupGate.resolve(session(sessionKey));
    await persist;

    expect(store.updateAgentSessionId).not.toHaveBeenCalled();
  });

  it('updates the session when the process context remains current', async () => {
    const store = {
      getByKey: vi.fn().mockResolvedValue(session('telegram:chat_1:ccbot')),
      updateAgentSessionId: vi.fn().mockResolvedValue(undefined),
    };

    await persistAgentSessionIdIfCurrent(
      store,
      'telegram:chat_1:ccbot',
      'agent-session-current',
      () => true,
    );

    expect(store.updateAgentSessionId).toHaveBeenCalledWith('session-row-1', 'agent-session-current');
  });
});

function session(key: SessionKey): Session {
  return {
    id: 'session-row-1',
    key,
    agentName: 'mock-agent',
    workingDirectory: '/Users/test/project',
    state: 'active',
    createdAt: 1,
    lastActiveAt: 1,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
