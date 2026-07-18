import type {
  AgentCapabilities,
  SessionKey,
  HandoffRequest,
  HandoffResult,
  HandoffRelease,
  Session,
} from '../types.js';

export interface HandoffDeps {
  spawnResume: (
    sessionKey: SessionKey,
    agentName: string,
    sessionId: string,
    workDir: string,
  ) => Promise<{ pid: number; sessionId: string }>;
  getSession: (sessionKey: SessionKey) => Promise<Session | null>;
  updateState: (sessionId: string, state: Session['state']) => Promise<void>;
  getAgentCapabilities?: (agentName: string) => Pick<AgentCapabilities, 'sessionResume'> | undefined;
  getBotAgent?: (botName: string) => string | undefined;
}

export interface AcceptHandoffOptions {
  lockAlreadyAcquired?: boolean;
  beforeProceed?: () => void | Promise<void>;
}

const UNSUPPORTED_HANDOFF = '该 agent 不支持会话恢复/交接';

export class HandoffService {
  private deps: HandoffDeps;
  private locks = new Set<SessionKey>();

  constructor(deps: HandoffDeps) {
    this.deps = deps;
  }

  isHandoffInProgress(sessionKey: SessionKey): boolean {
    return this.locks.has(sessionKey);
  }

  tryAcquireLock(sessionKey: SessionKey): boolean {
    if (this.locks.has(sessionKey)) {
      return false;
    }

    this.locks.add(sessionKey);
    return true;
  }

  releaseLock(sessionKey: SessionKey): void {
    this.locks.delete(sessionKey);
  }

  async acceptHandoff(req: HandoffRequest, opts?: AcceptHandoffOptions): Promise<HandoffResult> {
    const chatId = req.chatId ?? 'default';
    const platform = req.platform ?? 'feishu';
    const sessionKey: SessionKey = `${platform}:${chatId}:${req.botName}`;

    if (this.deps.getAgentCapabilities?.(req.agentName)?.sessionResume === false) {
      return { success: false, error: UNSUPPORTED_HANDOFF };
    }

    const lockAlreadyAcquired = opts?.lockAlreadyAcquired === true;
    if (lockAlreadyAcquired && !this.locks.has(sessionKey)) {
      return { success: false, error: 'Handoff lock not acquired' };
    }

    if (!lockAlreadyAcquired && !this.tryAcquireLock(sessionKey)) {
      return { success: false, error: 'Handoff already in progress' };
    }

    try {
      await opts?.beforeProceed?.();
      await this.deps.spawnResume(sessionKey, req.agentName, req.sessionId, req.workDir);
      return { success: true };
    } catch (err) {
      console.error(`[handoff] accept failed for ${sessionKey}:`, err instanceof Error ? err.message : err);
      return { success: false, error: 'Handoff failed' };
    } finally {
      if (!lockAlreadyAcquired) {
        this.releaseLock(sessionKey);
      }
    }
  }

  async releaseHandoff(sessionKey: SessionKey): Promise<HandoffRelease> {
    const botName = sessionKey.split(':')[2];
    const currentAgent = this.deps.getBotAgent?.(botName);
    if (currentAgent && this.deps.getAgentCapabilities?.(currentAgent)?.sessionResume === false) {
      throw new Error(UNSUPPORTED_HANDOFF);
    }

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
