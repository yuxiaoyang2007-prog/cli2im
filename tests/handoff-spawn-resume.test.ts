import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createHandoffSpawnResume } from '../src/index.js';
import type { AgentManagerEvents } from '../src/agents/manager.js';
import type { AgentProcess, Session, SessionKey } from '../src/types.js';

describe('handoff spawnResume store sync', () => {
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
});

function createDeps(session: Session) {
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
    onEvent: vi.fn(),
    onToolBlocked: vi.fn(),
    onPermissionTimeout: vi.fn(),
    onProcessExit: vi.fn(),
  }));

  return {
    agentManager,
    store,
    createEventHandlers,
    spawnResume: createHandoffSpawnResume(agentManager, store, createEventHandlers),
  };
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
