import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHandoffSpawnResume, startAgentProcessForSession } from '../src/index.js';
import type { AgentManagerEvents } from '../src/agents/manager.js';
import type { AgentPlugin, AgentProcess, BotConfig, Session, SessionKey } from '../src/types.js';

describe('handoff spawnResume store sync', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('updates an existing row after resume succeeds', async () => {
    const sessionKey = 'telegram:chat_1:codexbot' as SessionKey;
    const existingSession = sessionRow('row_existing', sessionKey);
    const { spawnResume, agentManager, store, createEventHandlers } = createDeps(existingSession);

    await expect(spawnResume(sessionKey, 'codex', 'agent_session_1', '~/project-a')).resolves.toEqual({
      pid: 123,
      sessionId: 'agent_session_1',
    });

    const normalizedWorkDir = join(homedir(), 'project-a');
    expect(createEventHandlers).toHaveBeenCalledWith(sessionKey);
    expect(agentManager.resumeAgent).toHaveBeenCalledWith(
      sessionKey,
      'codex',
      'agent_session_1',
      { workingDirectory: '~/project-a', permissionMode: 'blacklist' },
      expect.any(Object),
    );
    expect(store.getOrCreate).toHaveBeenCalledWith(sessionKey, {
      agentName: 'codex',
      workingDirectory: normalizedWorkDir,
    });
    expect(store.updateWorkingDirectory).toHaveBeenCalledWith('row_existing', normalizedWorkDir);
    expect(store.updateAgentSessionId).toHaveBeenCalledWith('row_existing', 'agent_session_1');
    expect(store.updateState).toHaveBeenCalledWith('row_existing', 'active');
    expect(store.touch).toHaveBeenCalledWith('row_existing');
  });

  it('creates and updates a row when handoff starts before any IM session exists', async () => {
    const sessionKey = 'feishu:chat_2:super-gpt' as SessionKey;
    const createdSession = sessionRow('row_created', sessionKey);
    const { spawnResume, store } = createDeps(createdSession);

    await spawnResume(sessionKey, 'codex', 'agent_session_2', '~/project-b');

    const normalizedWorkDir = join(homedir(), 'project-b');
    expect(store.getOrCreate).toHaveBeenCalledWith(sessionKey, {
      agentName: 'codex',
      workingDirectory: normalizedWorkDir,
    });
    expect(store.updateWorkingDirectory).toHaveBeenCalledWith('row_created', normalizedWorkDir);
    expect(store.updateAgentSessionId).toHaveBeenCalledWith('row_created', 'agent_session_2');
    expect(store.updateState).toHaveBeenCalledWith('row_created', 'active');
    expect(store.touch).toHaveBeenCalledWith('row_created');
  });

  it('applies per-bot AGENTS.md instructions on handoff resume', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'cli2im-handoff-agents-'));
    tempDirs.push(workDir);
    writeFileSync(join(workDir, 'AGENTS.md'), 'Resumed sessions still follow this.');

    const sessionKey = 'feishu:chat_1:ccbot' as SessionKey;
    const existingSession = sessionRow('row_cc', sessionKey);
    const getBotConfig = vi.fn(() => botConfig({ agent: 'claude-code' }));
    const { spawnResume, agentManager } = createDeps(existingSession, getBotConfig);

    await spawnResume(sessionKey, 'claude-code', 'agent_session_cc', workDir);

    expect(getBotConfig).toHaveBeenCalledWith('ccbot');
    expect(agentManager.resumeAgent).toHaveBeenCalledWith(
      sessionKey,
      'claude-code',
      'agent_session_cc',
      {
        workingDirectory: workDir,
        permissionMode: 'blacklist',
        appendSystemPrompt: 'Resumed sessions still follow this.',
      },
      expect.any(Object),
    );
  });

  it('keeps legacy opts for non-PTY handoff resumes', async () => {
    const sessionKey = 'feishu:chat_1:codexbot' as SessionKey;
    const existingSession = sessionRow('row_codex', sessionKey);
    const getBotConfig = vi.fn(() => botConfig({
      agent: 'claude-code',
      permissionMode: 'bypass',
      idleTimeoutMs: 30_000,
    }));
    const { spawnResume, agentManager } = createDeps(existingSession, getBotConfig);

    await spawnResume(sessionKey, 'codex', 'agent_session_codex', '~/project-codex');

    expect(agentManager.resumeAgent).toHaveBeenCalledWith(
      sessionKey,
      'codex',
      'agent_session_codex',
      { workingDirectory: '~/project-codex', permissionMode: 'blacklist' },
      expect.any(Object),
    );
  });
});

describe('startAgentProcessForSession session resume id selection', () => {
  it('durably prewrites the manager latest session id before resuming', async () => {
    const sessionKey = 'telegram:chat_1:codexbot' as SessionKey;
    const session = sessionRow('row_existing', sessionKey);
    session.agentSessionId = 'agent_session_s1';
    const updateGate = deferred<void>();
    const order: string[] = [];
    const agentManager = {
      getPlugin: vi.fn(() => ({
        capabilities: { sessionResume: true },
      }) as AgentPlugin),
      getLatestSessionId: vi.fn(() => 'agent_session_s2'),
      resumeAgent: vi.fn(async () => {
        order.push('resume');
        return { pid: 123 } as AgentProcess;
      }),
      spawnAgent: vi.fn(),
    };
    const store = {
      updateAgentSessionId: vi.fn(async () => {
        order.push('update-start');
        await updateGate.promise;
        order.push('update-end');
      }),
    };
    const handlers = createHandlers();

    const started = startAgentProcessForSession({
      agentManager,
      store,
      session,
      sessionKey,
      agentName: 'codex',
      spawnOpts: { workingDirectory: '~/project-a', permissionMode: 'blacklist' },
      handlers,
    });

    await vi.waitFor(() => expect(store.updateAgentSessionId).toHaveBeenCalledTimes(1));
    expect(agentManager.resumeAgent).not.toHaveBeenCalled();

    updateGate.resolve();
    await started;

    expect(store.updateAgentSessionId).toHaveBeenCalledWith('row_existing', 'agent_session_s2');
    expect(agentManager.resumeAgent).toHaveBeenCalledWith(
      sessionKey,
      'codex',
      'agent_session_s2',
      { workingDirectory: '~/project-a', permissionMode: 'blacklist' },
      handlers,
    );
    expect(agentManager.spawnAgent).not.toHaveBeenCalled();
    expect(order).toEqual(['update-start', 'update-end', 'resume']);
  });
});

function createDeps(
  session: Session,
  getBotConfig?: (botName: string) => BotConfig | undefined,
  resolveSpawnOpts?: Parameters<typeof createHandoffSpawnResume>[4],
) {
  const agentManager = {
    resumeAgent: vi.fn(async () => ({ pid: 123 }) as AgentProcess),
  };
  const store = {
    getOrCreate: vi.fn(async () => session),
    updateWorkingDirectory: vi.fn(async () => undefined),
    updateAgentSessionId: vi.fn(async () => undefined),
    updateState: vi.fn(async () => undefined),
    touch: vi.fn(async () => undefined),
  };
  const createEventHandlers = vi.fn((): AgentManagerEvents => ({
    ...createHandlers(),
  }));

  return {
    agentManager,
    store,
    createEventHandlers,
    spawnResume: createHandoffSpawnResume(agentManager, store, createEventHandlers, getBotConfig, resolveSpawnOpts),
  };
}

function createHandlers(): AgentManagerEvents {
  return {
    onEvent: vi.fn(),
    onToolBlocked: vi.fn(),
    onPermissionTimeout: vi.fn(),
    onProcessExit: vi.fn(),
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

function sessionRow(id: string, key: SessionKey): Session {
  return {
    id,
    key,
    agentName: 'codex',
    workingDirectory: '/Users/test/old-project',
    state: 'active',
    createdAt: 0,
    lastActiveAt: 0,
  };
}

function botConfig(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    agent: 'codex',
    platform: 'feishu',
    feishu: { appId: 'cli_abc', appSecret: 'secret' },
    workingDirectory: '/Users/test/project',
    allowFrom: ['ou_allowed'],
    permissionMode: 'blacklist',
    ...overrides,
  };
}
