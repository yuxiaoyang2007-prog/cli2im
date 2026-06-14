import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CLISessionScanner } from '../session/cli-scanner.js';
import { CodexSessionScanner } from '../session/codex-scanner.js';
import { GeminiSessionScanner } from '../session/gemini-scanner.js';
import { buildHandoffNotification } from '../platforms/feishu/markdown.js';
import { validateWorkingDirectory } from '../security/validators.js';
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
  store: Pick<SessionStore, 'getOrCreate' | 'updateAgentSessionId' | 'updateWorkingDirectory' | 'updateState' | 'touch'>;
  agentManager: Pick<AgentManager, 'cancelAgent'>;
  handoffService: Pick<HandoffService, 'acceptHandoff' | 'tryAcquireLock' | 'releaseLock'>;
  cardController: { interruptCard(sessionKey: SessionKey): void } | undefined;
  tgStreamController: { interrupt(sessionKey: SessionKey): void } | undefined;
}): Promise<void> {
  const { callback, resume, botName, botConfig, adapter, store, agentManager, handoffService } = params;
  if (!callback.chatId) {
    throw new Error('Missing chat id in callback');
  }

  const platform = callback.platform ?? 'feishu';
  const sessionKey: SessionKey = `${platform}:${callback.chatId}:${botName}`;
  if (!handoffService.tryAcquireLock(sessionKey)) {
    await adapter.send(callback.chatId, { text: 'Resume failed: Resume already in progress' });
    return;
  }

  try {
    let workDir = resume.cwd;
    if (!workDir) {
      const scanner = botConfig.agent === 'gemini'
        ? new GeminiSessionScanner(join(homedir(), '.gemini'))
        : botConfig.agent === 'codex'
          ? new CodexSessionScanner(join(homedir(), '.codex'))
          : new CLISessionScanner(join(homedir(), '.claude'));
      const sessions = botConfig.agent === 'claude-code-pty'
        ? await scanner.scan({ cwdFilter: botConfig.workingDirectory })
        : await scanner.scan();
      const match = sessions.find((s) => s.sessionId === resume.sessionId);
      if (!match?.cwd && botConfig.agent === 'claude-code-pty') {
        await adapter.send(callback.chatId, {
          text: `Resume failed: could not resolve cwd for session \`${resume.sessionId}\``,
        });
        return;
      }
      workDir = match?.cwd || homedir();
    }

    if (botConfig.agent === 'claude-code-pty') {
      const allowed = await cwdMatchesBotWorkingDirectory(workDir, botConfig.workingDirectory);
      if (!allowed) {
        await adapter.send(callback.chatId, {
          text: `Resume failed: session cwd is outside this bot working directory \`${botConfig.workingDirectory}\``,
        });
        return;
      }
    }

    if (!(await validateWorkingDirectory(workDir))) {
      await adapter.send(callback.chatId, { text: `Resume failed: invalid cwd \`${workDir}\`` });
      return;
    }

    const agentName = botConfig.agent;
    agentManager.cancelAgent(sessionKey);
    params.cardController?.interruptCard(sessionKey);
    params.tgStreamController?.interrupt(sessionKey);

    const result = await handoffService.acceptHandoff({
      botName,
      sessionId: resume.sessionId,
      workDir,
      agentName,
      chatId: callback.chatId,
      platform: callback.platform,
    }, { lockAlreadyAcquired: true });

    if (!result.success) {
      await adapter.send(callback.chatId, { text: `Resume failed: ${result.error}` });
      return;
    }

    const session = await store.getOrCreate(sessionKey, {
      agentName,
      workingDirectory: workDir,
    });
    await store.updateAgentSessionId(session.id, resume.sessionId);
    await store.updateWorkingDirectory(session.id, workDir);
    await store.updateState(session.id, 'active');
    await store.touch(session.id);

    await adapter.send(callback.chatId, {
      text: buildHandoffNotification({
        sessionId: resume.sessionId,
        workDir,
        agentName,
      }),
    });
  } finally {
    handoffService.releaseLock(sessionKey);
  }
}

async function cwdMatchesBotWorkingDirectory(cwd: string, workingDirectory: string): Promise<boolean> {
  const [cwdRealpath, workingDirectoryRealpath] = await Promise.all([
    resolveComparablePath(cwd),
    resolveComparablePath(workingDirectory),
  ]);
  return !!cwdRealpath && cwdRealpath === workingDirectoryRealpath;
}

async function resolveComparablePath(path: string): Promise<string | undefined> {
  if (!path) return undefined;
  try {
    return await realpath(expandHome(path));
  } catch {
    return undefined;
  }
}

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}
