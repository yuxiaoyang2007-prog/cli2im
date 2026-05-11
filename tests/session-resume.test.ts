import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleCLISessionResume } from '../src/runtime/session-resume.js';
import { HandoffService } from '../src/services/handoff.js';
import type { BotConfig, CallbackQuery, SessionKey } from '../src/types.js';

const validatorMock = vi.hoisted(() => ({
  validateWorkingDirectory: vi.fn(),
}));

vi.mock('../src/security/validators.js', () => ({
  validateWorkingDirectory: validatorMock.validateWorkingDirectory,
}));

describe('handleCLISessionResume', () => {
  beforeEach(() => {
    validatorMock.validateWorkingDirectory.mockReset();
    validatorMock.validateWorkingDirectory.mockImplementation(async (path: string) => path.startsWith('/Users/'));
  });

  it('claims the resume lock before validating callback cwd', async () => {
    const store = storeDeps();
    const handoffService = lockingHandoffDeps({ success: true });
    const adapter = { send: vi.fn().mockResolvedValue('msg_1') };

    await handleCLISessionResume({
      callback: callback(),
      resume: { sessionId: 'session_123', cwd: '/etc' },
      botName: 'ccbot',
      botConfig: botConfig(),
      adapter,
      store,
      agentManager: { cancelAgent: vi.fn() },
      handoffService,
      cardController: undefined,
      tgStreamController: undefined,
    });

    expect(handoffService.tryAcquireLock).toHaveBeenCalledWith('feishu:chat_1:ccbot');
    expect(handoffService.releaseLock).toHaveBeenCalledWith('feishu:chat_1:ccbot');
    expect(handoffService.tryAcquireLock.mock.invocationCallOrder[0]).toBeLessThan(
      validatorMock.validateWorkingDirectory.mock.invocationCallOrder[0],
    );
    expect(adapter.send).toHaveBeenCalledWith('chat_1', {
      text: 'Resume failed: invalid cwd `/etc`',
    });
    expect(handoffService.acceptHandoff).not.toHaveBeenCalled();
    expect(store.getOrCreate).not.toHaveBeenCalled();
    expect(store.updateAgentSessionId).not.toHaveBeenCalled();
    expect(store.updateWorkingDirectory).not.toHaveBeenCalled();
    expect(store.updateState).not.toHaveBeenCalled();
    expect(store.touch).not.toHaveBeenCalled();
  });

  it('rejects a concurrent resume while the first resume is still validating cwd', async () => {
    const store = storeDeps();
    const handoffService = lockingHandoffDeps({ success: true });
    const adapter = { send: vi.fn().mockResolvedValue('msg_1') };
    const validationGate = deferred<boolean>();
    validatorMock.validateWorkingDirectory.mockReturnValue(validationGate.promise);

    const params = {
      callback: callback(),
      resume: { sessionId: 'session_123', cwd: '/Users/test/project' },
      botName: 'ccbot',
      botConfig: botConfig(),
      adapter,
      store,
      agentManager: { cancelAgent: vi.fn() },
      handoffService,
      cardController: undefined,
      tgStreamController: undefined,
    };

    const first = handleCLISessionResume(params);
    await vi.waitFor(() => expect(handoffService.tryAcquireLock).toHaveBeenCalledTimes(1));

    await handleCLISessionResume(params);

    expect(adapter.send).toHaveBeenCalledWith('chat_1', {
      text: 'Resume failed: Resume already in progress',
    });
    expect(handoffService.acceptHandoff).not.toHaveBeenCalled();

    validationGate.resolve(true);
    await first;

    expect(handoffService.acceptHandoff).toHaveBeenCalledTimes(1);
  });

  it('updates session store only after handoff succeeds', async () => {
    const store = storeDeps();
    const handoffService = handoffDeps({ success: true });
    const adapter = { send: vi.fn().mockResolvedValue('msg_1') };

    await handleCLISessionResume({
      callback: callback(),
      resume: { sessionId: 'session_123', cwd: '/Users/test/project' },
      botName: 'ccbot',
      botConfig: botConfig(),
      adapter,
      store,
      agentManager: { cancelAgent: vi.fn() },
      handoffService,
      cardController: { interruptCard: vi.fn() },
      tgStreamController: { interrupt: vi.fn() },
    });

    expect(handoffService.acceptHandoff).toHaveBeenCalledTimes(1);
    expect(handoffService.acceptHandoff).toHaveBeenCalledWith(expect.any(Object), { lockAlreadyAcquired: true });
    expect(handoffService.releaseLock).toHaveBeenCalledWith('feishu:chat_1:ccbot');
    expect(store.getOrCreate).toHaveBeenCalledTimes(1);
    expect(store.updateWorkingDirectory).toHaveBeenCalledWith('session_row_1', '/Users/test/project');
    expect(adapter.send).toHaveBeenCalledWith('chat_1', {
      text: expect.stringContaining('**已接管会话**'),
    });
  });

  it('cancels the old active process after acquiring the handoff lock', async () => {
    const store = storeDeps();
    const cancelAgent = vi.fn();
    const handoffService = handoffDeps({ success: true });
    const adapter = { send: vi.fn().mockResolvedValue('msg_1') };

    await handleCLISessionResume({
      callback: callback(),
      resume: { sessionId: 'session_123', cwd: '/Users/test/project' },
      botName: 'ccbot',
      botConfig: botConfig(),
      adapter,
      store,
      agentManager: { cancelAgent },
      handoffService,
      cardController: undefined,
      tgStreamController: undefined,
    });

    expect(handoffService.tryAcquireLock).toHaveBeenCalledWith('feishu:chat_1:ccbot');
    expect(cancelAgent).toHaveBeenCalledWith('feishu:chat_1:ccbot');
    expect(handoffService.tryAcquireLock.mock.invocationCallOrder[0]).toBeLessThan(
      cancelAgent.mock.invocationCallOrder[0],
    );
    expect(cancelAgent.mock.invocationCallOrder[0]).toBeLessThan(
      handoffService.acceptHandoff.mock.invocationCallOrder[0],
    );
  });

  it('does not update session store when handoff fails', async () => {
    const store = storeDeps();
    const handoffService = handoffDeps({ success: false, error: 'spawn failed' });
    const adapter = { send: vi.fn().mockResolvedValue('msg_1') };

    await handleCLISessionResume({
      callback: callback(),
      resume: { sessionId: 'session_123', cwd: '/Users/test/project' },
      botName: 'ccbot',
      botConfig: botConfig(),
      adapter,
      store,
      agentManager: { cancelAgent: vi.fn() },
      handoffService,
      cardController: undefined,
      tgStreamController: undefined,
    });

    expect(adapter.send).toHaveBeenCalledWith('chat_1', { text: 'Resume failed: spawn failed' });
    expect(handoffService.releaseLock).toHaveBeenCalledWith('feishu:chat_1:ccbot');
    expect(store.getOrCreate).not.toHaveBeenCalled();
    expect(store.updateWorkingDirectory).not.toHaveBeenCalled();
  });

  it('rejects a concurrent resume before cancellation or spawn touches the active session', async () => {
    const store = storeDeps();
    const cancelAgent = vi.fn();
    const adapter = { send: vi.fn().mockResolvedValue('msg_1') };
    const spawnGate = deferred<void>();
    const spawnResume = vi.fn(async () => {
      await spawnGate.promise;
      return { pid: 123, sessionId: 'session_123' };
    });
    const handoffService = new HandoffService({
      spawnResume,
      getSession: vi.fn().mockResolvedValue(null),
      updateState: vi.fn().mockResolvedValue(undefined),
    });

    const params = {
      callback: callback(),
      resume: { sessionId: 'session_123', cwd: '/Users/test/project' },
      botName: 'ccbot',
      botConfig: botConfig(),
      adapter,
      store,
      agentManager: { cancelAgent },
      handoffService,
      cardController: undefined,
      tgStreamController: undefined,
    };

    const first = handleCLISessionResume(params);
    await vi.waitFor(() => expect(spawnResume).toHaveBeenCalledTimes(1));

    const second = handleCLISessionResume(params);
    await second;

    expect(cancelAgent).toHaveBeenCalledTimes(1);
    expect(spawnResume).toHaveBeenCalledTimes(1);
    expect(adapter.send).toHaveBeenCalledWith('chat_1', {
      text: 'Resume failed: Resume already in progress',
    });
    expect(store.getOrCreate).not.toHaveBeenCalled();

    spawnGate.resolve();
    await first;

    expect(store.getOrCreate).toHaveBeenCalledTimes(1);
    expect(store.updateState).toHaveBeenCalledWith('session_row_1', 'active');
  });
});

function callback(): CallbackQuery {
  return {
    platform: 'feishu',
    chatId: 'chat_1',
    userId: 'ou_allowed',
    data: 'resume:session_123',
    messageId: 'msg_1',
  };
}

function botConfig(): BotConfig {
  return {
    agent: 'claude-code',
    platform: 'feishu',
    feishu: { appId: 'cli_abc', appSecret: 'secret' },
    workingDirectory: '/Users/test/project',
    allowFrom: ['ou_allowed'],
    permissionMode: 'blacklist',
  };
}

function storeDeps() {
  return {
    getOrCreate: vi.fn().mockResolvedValue({ id: 'session_row_1' }),
    updateAgentSessionId: vi.fn().mockResolvedValue(undefined),
    updateWorkingDirectory: vi.fn().mockResolvedValue(undefined),
    updateState: vi.fn().mockResolvedValue(undefined),
    touch: vi.fn().mockResolvedValue(undefined),
  };
}

function handoffDeps(result: { success: boolean; error?: string }) {
  return {
    tryAcquireLock: vi.fn().mockReturnValue(true),
    releaseLock: vi.fn(),
    acceptHandoff: vi.fn().mockResolvedValue(result),
  };
}

function lockingHandoffDeps(result: { success: boolean; error?: string }) {
  const locks = new Set<SessionKey>();
  return {
    tryAcquireLock: vi.fn((sessionKey: SessionKey) => {
      if (locks.has(sessionKey)) return false;
      locks.add(sessionKey);
      return true;
    }),
    releaseLock: vi.fn((sessionKey: SessionKey) => {
      locks.delete(sessionKey);
    }),
    acceptHandoff: vi.fn().mockResolvedValue(result),
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
