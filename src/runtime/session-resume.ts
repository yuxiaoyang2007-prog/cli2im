import { homedir } from 'node:os';
import { join } from 'node:path';
import { CLISessionScanner, type CLISession, type CLISessionScanOptions } from '../session/cli-scanner.js';
import { CodexSessionScanner } from '../session/codex-scanner.js';
import { GeminiSessionScanner } from '../session/gemini-scanner.js';
import { AntigravitySessionScanner } from '../session/antigravity-scanner.js';
import { buildHandoffNotification } from '../platforms/feishu/markdown.js';
import { validateWorkingDirectory } from '../security/validators.js';
import { canAccessSession, getBotAccessRejection } from '../security/access-policy.js';
import { buildSessionKey } from '../types.js';
import type { AgentManager } from '../agents/manager.js';
import type { HandoffService } from '../services/handoff.js';
import type { SessionStore } from '../session/store.js';
import type {
  BotConfig,
  CallbackQuery,
  PlatformAdapter,
  SessionKey,
} from '../types.js';

export async function handleCLISessionResume(params: {
  callback: CallbackQuery;
  resume: { sessionId: string; cwd: string };
  botName: string;
  botConfig: BotConfig;
  adapter: Pick<PlatformAdapter, 'send'>;
  store: Pick<SessionStore, 'getOrCreate' | 'updateAgentSessionId' | 'updateWorkingDirectory' | 'updateState' | 'touch'>
    & Partial<Pick<SessionStore, 'getByKey' | 'listByBot'>>
    & { getSessionAccess?: (agentName: string, agentSessionId: string) => Promise<Array<{
      key: SessionKey; agentName: string; agentSessionId: string; workingDirectory: string;
    }>> };
  scanSessions?: (agentName: string, options?: CLISessionScanOptions) => Promise<CLISession[]>;
  /** Captured by the caller before queueing; invalidated by stop/reset/shutdown. */
  ensureReady?: () => void;
  agentManager: Pick<AgentManager, 'cancelAgent'>;
  handoffService: Pick<HandoffService, 'acceptHandoff' | 'tryAcquireLock' | 'releaseLock'>;
  cardController: { interruptCard(sessionKey: SessionKey): void } | undefined;
  tgStreamController: { interrupt(sessionKey: SessionKey): void } | undefined;
}): Promise<void> {
  const { callback, resume, botName, botConfig, adapter, store, agentManager, handoffService } = params;
  if (!callback.chatId) {
    throw new Error('Missing chat id in callback');
  }
  if (getBotAccessRejection(callback, botConfig)) {
    await adapter.send(callback.chatId, { text: 'Resume failed: session not available to this conversation' });
    return;
  }
  const ensureReady = () => {
    params.ensureReady?.();
    if (getBotAccessRejection(callback, botConfig)) throw new Error('Session no longer available');
  };
  try {
    ensureReady();
  } catch {
    await adapter.send(callback.chatId, { text: 'Resume failed: request stopped or no longer available' });
    return;
  }

  const platform = callback.platform ?? 'feishu';
  const sessionKey = buildSessionKey(platform, callback.chatId, botName, callback.threadId);
  if (!handoffService.tryAcquireLock(sessionKey)) {
    await adapter.send(callback.chatId, { text: 'Resume failed: Resume already in progress' });
    return;
  }

  try {
    ensureReady();
    // A card is an untrusted reference, not proof of session ownership or cwd.
    const current = await store.getByKey?.(sessionKey);
    ensureReady();
    const bindings = await store.getSessionAccess?.(botConfig.agent, resume.sessionId) ?? [];
    ensureReady();
    const botSessions = await store.listByBot?.(botName) ?? [];
    ensureReady();
    const candidates = [current, ...bindings, ...botSessions]
      .filter((session) => session?.agentSessionId === resume.sessionId && session.agentName === botConfig.agent);
    let stored = candidates.find((session) => session?.key === sessionKey);
    if (!stored) {
      for (const candidate of candidates) {
        const allowed = candidate && await canAccessSession({ bot: botConfig, actor: callback, sessionKey, session: candidate });
        ensureReady();
        if (allowed) {
          stored = candidate;
          break;
        }
      }
    }
    const scanned = stored ? undefined : (await (params.scanSessions ?? scanAgentSessions)(botConfig.agent, { sessionId: resume.sessionId, limit: 1 }))
      .find((session) => session.sessionId === resume.sessionId);
    ensureReady();
    const record = stored ?? (scanned && { ...scanned, agentName: botConfig.agent });
    const allowed = record && await canAccessSession({ bot: botConfig, actor: callback, sessionKey, session: record });
    ensureReady();
    if (!allowed) {
      await adapter.send(callback.chatId, { text: 'Resume failed: session not available to this conversation' });
      return;
    }
    // Antigravity records have no cwd. Only an admin or a previously bound scope
    // can reach here; a configured shared root cannot authorize a cwd-less record.
    const workDir = stored?.workingDirectory || scanned?.cwd
      || (botConfig.agent === 'agy' ? botConfig.workingDirectory : '');

    const validWorkDir = await validateWorkingDirectory(workDir);
    ensureReady();
    if (!validWorkDir) {
      await adapter.send(callback.chatId, { text: `Resume failed: invalid cwd \`${workDir}\`` });
      return;
    }

    const agentName = botConfig.agent;
    const result = await handoffService.acceptHandoff({
      botName,
      sessionId: resume.sessionId,
      workDir,
      agentName,
      chatId: callback.chatId,
      platform: callback.platform,
      threadId: callback.threadId,
    }, {
      lockAlreadyAcquired: true,
      ...(params.ensureReady ? { ensureReady } : {}),
      beforeProceed: () => {
        ensureReady();
        agentManager.cancelAgent(sessionKey);
        params.cardController?.interruptCard(sessionKey);
        params.tgStreamController?.interrupt(sessionKey);
      },
    });
    ensureReady();

    if (!result.success) {
      await adapter.send(callback.chatId, { text: `Resume failed: ${result.error}` });
      return;
    }

    const session = await store.getOrCreate(sessionKey, {
      agentName,
      workingDirectory: workDir,
    });
    ensureReady();
    await store.updateWorkingDirectory(session.id, workDir);
    ensureReady();
    await store.updateAgentSessionId(session.id, resume.sessionId);
    ensureReady();
    await store.updateState(session.id, 'active');
    ensureReady();
    await store.touch(session.id);
    ensureReady();

    await adapter.send(callback.chatId, {
      text: buildHandoffNotification({
        sessionId: resume.sessionId,
        workDir,
        agentName,
      }),
    });
  } catch {
    await adapter.send(callback.chatId, { text: 'Resume failed: request stopped or no longer available' }).catch(() => {});
  } finally {
    handoffService.releaseLock(sessionKey);
  }
}

/** Scan the matching CLI only. Filtering/authorization must happen before display. */
export async function scanAgentSessions(agentName: string, options: CLISessionScanOptions = {}): Promise<CLISession[]> {
  const limit = options.limit ?? 20;
  if (agentName === 'claude-code') return new CLISessionScanner(join(homedir(), '.claude')).scan({ ...options, limit });
  // These scanners read bounded index windows or already collect before sorting.
  const scanOptions = { limit: Number.MAX_SAFE_INTEGER };
  const candidates = agentName === 'agy'
    ? await new AntigravitySessionScanner(join(homedir(), '.gemini', 'antigravity-cli')).scan(scanOptions)
    : agentName === 'gemini' ? await new GeminiSessionScanner(join(homedir(), '.gemini')).scan(scanOptions)
    : agentName === 'codex' ? await new CodexSessionScanner(join(homedir(), '.codex')).scan(scanOptions) : [];
  const sessions: CLISession[] = [];
  for (const candidate of candidates) {
    if (sessions.length >= limit) break;
    if (options.sessionId && candidate.sessionId !== options.sessionId) continue;
    if (!options.accept || await options.accept(candidate)) sessions.push(candidate);
  }
  return sessions;
}
