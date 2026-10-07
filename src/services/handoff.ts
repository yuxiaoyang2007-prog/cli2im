import type {
  AgentCapabilities,
  SessionKey,
  HandoffRequest,
  HandoffResult,
  HandoffRelease,
  Session,
} from '../types.js';
import { buildSessionKey } from '../types.js';

export interface HandoffDeps {
  spawnResume: (
    sessionKey: SessionKey,
    agentName: string,
    sessionId: string,
    workDir: string,
    ensureReady?: () => void,
  ) => Promise<{ pid: number; sessionId: string }>;
  getSession: (sessionKey: SessionKey) => Promise<Session | null>;
  updateState: (sessionId: string, state: Session['state']) => Promise<void>;
  getAgentCapabilities?: (agentName: string) => Pick<AgentCapabilities, 'sessionResume'> | undefined;
  getBotAgent?: (botName: string) => string | undefined;
  getBotPlatform?: (botName: string) => string | undefined;
  isSessionBusy?: (agentName: string, id: string, exceptKey: SessionKey) => boolean;
}

export interface AcceptHandoffOptions {
  lockAlreadyAcquired?: boolean;
  beforeProceed?: () => void | Promise<void>;
  ensureReady?: () => void;
}

const UNSUPPORTED_HANDOFF = '该 agent 不支持会话恢复/交接';

export class HandoffService {
  private deps: HandoffDeps;
  private locks = new Set<SessionKey>();
  private agentSessionLocks = new Set<string>();

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
    try {
      opts?.ensureReady?.();
    } catch {
      return { success: false, error: 'Handoff failed' };
    }
    const chatId = req.chatId ?? 'default';
    const configuredPlatform = this.deps.getBotPlatform?.(req.botName);
    if (req.platform && configuredPlatform && req.platform !== configuredPlatform) {
      return { success: false, error: 'Platform does not match bot configuration' };
    }
    const platform = req.platform ?? configuredPlatform ?? 'feishu';
    const sessionKey = buildSessionKey(platform, chatId, req.botName, req.threadId);
    const agentSessionKey = `${req.agentName}:${req.sessionId}`;
    if (this.agentSessionLocks.has(agentSessionKey) || this.deps.isSessionBusy?.(req.agentName, req.sessionId, sessionKey)) {
      return { success: false, error: '这段对话已被另一个机器人或聊天接管，请先在原处交还或停止' };
    }

    const configuredAgent = this.deps.getBotAgent?.(req.botName);
    if (configuredAgent && configuredAgent !== req.agentName) {
      return { success: false, error: 'Agent does not match bot configuration' };
    }

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

    this.agentSessionLocks.add(agentSessionKey);
    try {
      opts?.ensureReady?.();
      await opts?.beforeProceed?.();
      opts?.ensureReady?.();
      if (opts?.ensureReady) await this.deps.spawnResume(sessionKey, req.agentName, req.sessionId, req.workDir, opts.ensureReady);
      else await this.deps.spawnResume(sessionKey, req.agentName, req.sessionId, req.workDir);
      opts?.ensureReady?.();
      return { success: true };
    } catch (err) {
      console.error('[handoff] accept_failed');
      return { success: false, error: 'Handoff failed' };
    } finally {
      this.agentSessionLocks.delete(agentSessionKey);
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
      resumeCommand: buildResumeCommand(currentAgent ?? session.agentName, sessionId),
    };
  }
}

export function buildResumeCommand(agentName: string, sessionId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) throw new Error('Invalid session id');
  switch (agentName) {
    case 'claude-code': return `claude --resume ${sessionId}`;
    case 'codex': return `codex resume ${sessionId}`;
    case 'gemini': return `gemini --resume ${sessionId}`;
    case 'agy': return `agy --resume ${sessionId}`;
    default: throw new Error(UNSUPPORTED_HANDOFF);
  }
}
