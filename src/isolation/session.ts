import type { AgentManager } from '../agents/manager.js';
import type { SessionStore } from '../session/store.js';
import type { Session, SessionKey } from '../types.js';
import type { IsolationRuntime } from './runtime.js';

/** Ordinary messages (including model/exit restarts) replace a stale session once; explicit resumes never do. */
export async function reconcileIsolatedSession(params: {
  runtime: Pick<IsolationRuntime, 'canResume'>; manager: Pick<AgentManager, 'getLatestSessionId' | 'forgetSession'>;
  store: Pick<SessionStore, 'clearAgentSessionId'>; session: Session; key: SessionKey;
  notify: () => Promise<unknown>;
}): Promise<void> {
  const id = params.manager.getLatestSessionId(params.key) ?? params.session.agentSessionId;
  if (!id || await params.runtime.canResume(params.key, id)) return;
  params.manager.forgetSession(params.key);
  await params.store.clearAgentSessionId(params.session.id);
  params.session.agentSessionId = undefined;
  await params.notify();
}
