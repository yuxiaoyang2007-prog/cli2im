import type { SessionKey, HandoffRequest, HandoffResult, HandoffRelease, Session } from '../types.js';

export interface HandoffDeps {
  spawnResume: (
    sessionKey: SessionKey,
    agentName: string,
    sessionId: string,
    workDir: string,
  ) => Promise<{ pid: number; sessionId: string }>;
  getSession: (sessionKey: SessionKey) => Promise<Session | null>;
  updateState: (sessionId: string, state: Session['state']) => Promise<void>;
}

export class HandoffService {
  private deps: HandoffDeps;
  private locks = new Set<SessionKey>();

  constructor(deps: HandoffDeps) {
    this.deps = deps;
  }

  isHandoffInProgress(sessionKey: SessionKey): boolean {
    return this.locks.has(sessionKey);
  }

  async acceptHandoff(req: HandoffRequest): Promise<HandoffResult> {
    const chatId = req.chatId ?? 'default';
    const sessionKey: SessionKey = `feishu:${chatId}:${req.botName}`;

    if (this.locks.has(sessionKey)) {
      return { success: false, error: 'Handoff already in progress' };
    }

    this.locks.add(sessionKey);

    try {
      await this.deps.spawnResume(sessionKey, req.agentName, req.sessionId, req.workDir);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      this.locks.delete(sessionKey);
    }
  }

  async releaseHandoff(sessionKey: SessionKey): Promise<HandoffRelease> {
    const session = await this.deps.getSession(sessionKey);
    if (!session) {
      throw new Error('No active session to release');
    }

    const sessionId = session.agentSessionId ?? session.id;
    await this.deps.updateState(session.id, 'handed_off');

    return {
      sessionId,
      resumeCommand: `claude --resume ${sessionId}`,
    };
  }
}
