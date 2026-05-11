import type { SessionStore } from '../session/store.js';
import type { SessionKey } from '../types.js';

type SessionIdStore = Pick<SessionStore, 'getByKey' | 'updateAgentSessionId'>;

export async function persistAgentSessionIdIfCurrent(
  store: SessionIdStore,
  sessionKey: SessionKey,
  agentSessionId: string,
  isCurrent: () => boolean,
  options?: { signal?: AbortSignal },
): Promise<void> {
  const isActive = () => isCurrent() && !options?.signal?.aborted;
  if (!isActive()) return;

  const session = await store.getByKey(sessionKey);
  if (!session || !isActive()) return;

  await store.updateAgentSessionId(session.id, agentSessionId);
}
