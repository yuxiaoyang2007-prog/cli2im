import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleCLISessionResume } from '../src/runtime/session-resume.js';
import { HandoffService } from '../src/services/handoff.js';
import { PreparationGuard } from '../src/runtime/preparation-guard.js';
import type { BotConfig, CallbackQuery, SessionKey } from '../src/types.js';

const validatorMock = vi.hoisted(() => ({
  validateWorkingDirectory: vi.fn(),
}));
const cliScannerMock = vi.hoisted(() => ({
  scan: vi.fn(),
}));

vi.mock('../src/security/validators.js', () => ({
  validateWorkingDirectory: validatorMock.validateWorkingDirectory,
}));
vi.mock('../src/session/cli-scanner.js', () => ({
  CLISessionScanner: vi.fn(function () { return { scan: cliScannerMock.scan }; }),
}));

describe('handleCLISessionResume', () => {
  beforeEach(() => {
    validatorMock.validateWorkingDirectory.mockReset();
    validatorMock.validateWorkingDirectory.mockImplementation(async (path: string) => path.startsWith('/Users/'));
    cliScannerMock.scan.mockReset();
    cliScannerMock.scan.mockResolvedValue([]);
  });

  it('claims the resume lock before validating the authoritative stored cwd', async () => {
    const store = storeDeps();
    store.getByKey.mockResolvedValue({ ...storedSession(), workingDirectory: '/etc' });
    const handoffService = lockingHandoffDeps({ success: true });
    const adapter = { send: vi.fn().mockResolvedValue('msg_1') };

    await handleCLISessionResume({
      callback: callback(),
      resume: { sessionId: 'session_123', cwd: '/Users/test/forged' },
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
    expect(handoffService.acceptHandoff).toHaveBeenCalledWith(expect.any(Object), {
      lockAlreadyAcquired: true,
      beforeProceed: expect.any(Function),
    });
    expect(handoffService.releaseLock).toHaveBeenCalledWith('feishu:chat_1:ccbot');
    expect(store.getOrCreate).toHaveBeenCalledTimes(1);
    expect(store.updateWorkingDirectory).toHaveBeenCalledWith('session_row_1', '/Users/test/project');
    expect(adapter.send).toHaveBeenCalledWith('chat_1', {
      text: expect.stringContaining('**已接管会话**'),
    });
  });

  it('cancels the old active process from the gated beforeProceed callback', async () => {
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
    expect(handoffService.acceptHandoff.mock.invocationCallOrder[0]).toBeLessThan(
      cancelAgent.mock.invocationCallOrder[0],
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

  it('keeps non-pty callback resume behavior unchanged', async () => {
    validatorMock.validateWorkingDirectory.mockResolvedValue(true);
    const store = storeDeps('codex');
    const handoffService = handoffDeps({ success: true });
    const adapter = { send: vi.fn().mockResolvedValue('msg_1') };

    await handleCLISessionResume({
      callback: callback(),
      resume: { sessionId: 'session_123', cwd: '/Users/test/project' },
      botName: 'ccbot',
      botConfig: botConfig({ agent: 'codex' }),
      adapter,
      store,
      agentManager: { cancelAgent: vi.fn() },
      handoffService,
      cardController: undefined,
      tgStreamController: undefined,
    });

    expect(cliScannerMock.scan).not.toHaveBeenCalled();
    expect(handoffService.acceptHandoff).toHaveBeenCalledWith(expect.objectContaining({
      workDir: '/Users/test/project',
      agentName: 'codex',
    }), {
      lockAlreadyAcquired: true,
      beforeProceed: expect.any(Function),
    });
  });

  it('does not cancel, interrupt, spawn, or write the store when capability gating rejects resume', async () => {
    const store = storeDeps('kimi-work', 'old-session');
    store.getByKey.mockResolvedValue({ ...storedSession('kimi-work', 'old-session'), key: 'feishu:chat_1:kimibot' });
    const cancelAgent = vi.fn();
    const cardController = { interruptCard: vi.fn() };
    const tgStreamController = { interrupt: vi.fn() };
    const spawnResume = vi.fn();
    const handoffService = new HandoffService({
      spawnResume,
      getSession: vi.fn().mockResolvedValue(null),
      updateState: vi.fn().mockResolvedValue(undefined),
      getAgentCapabilities: vi.fn().mockReturnValue({ sessionResume: false }),
      getBotAgent: vi.fn().mockReturnValue('kimi-work'),
    });
    const adapter = { send: vi.fn().mockResolvedValue('msg_1') };

    await handleCLISessionResume({
      callback: callback(),
      resume: { sessionId: 'old-session', cwd: '/Users/test/project' },
      botName: 'kimibot',
      botConfig: botConfig({ agent: 'kimi-work' }),
      adapter,
      store,
      agentManager: { cancelAgent },
      handoffService,
      cardController,
      tgStreamController,
    });

    expect(adapter.send).toHaveBeenCalledWith('chat_1', {
      text: 'Resume failed: 该 agent 不支持会话恢复/交接',
    });
    expect(cancelAgent).not.toHaveBeenCalled();
    expect(cardController.interruptCard).not.toHaveBeenCalled();
    expect(tgStreamController.interrupt).not.toHaveBeenCalled();
    expect(spawnResume).not.toHaveBeenCalled();
    expect(store.getOrCreate).not.toHaveBeenCalled();
    expect(store.updateAgentSessionId).not.toHaveBeenCalled();
    expect(store.updateWorkingDirectory).not.toHaveBeenCalled();
    expect(store.updateState).not.toHaveBeenCalled();
    expect(store.touch).not.toHaveBeenCalled();
  });

  it('ignores a forged button cwd and uses the current scope record', async () => {
    const store = storeDeps();
    const handoffService = handoffDeps({ success: true });
    await handleCLISessionResume(resumeParams({ store, handoffService,
      resume: { sessionId: 'session_123', cwd: '/Users/other/private' } }));
    expect(handoffService.acceptHandoff).toHaveBeenCalledWith(expect.objectContaining({
      workDir: '/Users/test/project',
    }), expect.anything());
  });

  it('rejects another conversation session even if the button claims an allowed cwd', async () => {
    const store = storeDeps();
    store.getByKey.mockResolvedValue(null);
    store.listByBot.mockResolvedValue([{ ...storedSession(), key: 'feishu:other_chat:ccbot' }]);
    cliScannerMock.scan.mockResolvedValue([{ sessionId: 'session_123', cwd: '/Users/test/project' }]);
    const handoffService = handoffDeps({ success: true });
    const adapter = { send: vi.fn().mockResolvedValue('msg_1') };
    await handleCLISessionResume(resumeParams({ store, handoffService, adapter }));
    expect(handoffService.acceptHandoff).not.toHaveBeenCalled();
    expect(store.updateAgentSessionId).not.toHaveBeenCalled();
    expect(adapter.send).toHaveBeenCalledWith('chat_1', { text: 'Resume failed: session not available to this conversation' });
  });

  it('allows the owner to resume an authoritative desktop session outside the default project', async () => {
    const store = storeDeps();
    store.getByKey.mockResolvedValue(null);
    cliScannerMock.scan.mockResolvedValue([{ sessionId: 'session_123', cwd: '/Users/owner/another-project' }]);
    const handoffService = handoffDeps({ success: true });
    await handleCLISessionResume(resumeParams({ store, handoffService,
      botConfig: botConfig({ adminUsers: ['ou_allowed'] }) }));
    expect(handoffService.acceptHandoff).toHaveBeenCalledWith(expect.objectContaining({
      workDir: '/Users/owner/another-project',
    }), expect.anything());
  });

  it('does not let an administrator resume an unknown caller-supplied session id', async () => {
    const store = storeDeps();
    store.getByKey.mockResolvedValue(null);
    const handoffService = handoffDeps({ success: true });
    await handleCLISessionResume(resumeParams({ store, handoffService,
      botConfig: botConfig({ adminUsers: ['ou_allowed'] }) }));
    expect(handoffService.acceptHandoff).not.toHaveBeenCalled();
    expect(validatorMock.validateWorkingDirectory).not.toHaveBeenCalled();
  });

  it('checks callback identity again inside the queued resume handler', async () => {
    const store = storeDeps();
    const handoffService = handoffDeps({ success: true });
    await handleCLISessionResume(resumeParams({ store, handoffService,
      callback: callback({ userId: 'ou_removed' }) }));
    expect(handoffService.tryAcquireLock).not.toHaveBeenCalled();
    expect(store.getByKey).not.toHaveBeenCalled();
  });

  it('keeps ownership of historical sessions after /new through stored access bindings', async () => {
    const store = storeDeps();
    store.getByKey.mockResolvedValue(null);
    store.getSessionAccess.mockResolvedValue([storedSession()]);
    const handoffService = handoffDeps({ success: true });
    await handleCLISessionResume(resumeParams({ store, handoffService }));
    expect(handoffService.acceptHandoff).toHaveBeenCalledTimes(1);
  });

  it('does not resume a sibling topic session in the same group', async () => {
    const store = storeDeps();
    store.getByKey.mockResolvedValue(null);
    store.getSessionAccess.mockResolvedValue([{ ...storedSession(), key: 'feishu:chat_1:ccbot:topic_a' }]);
    const handoffService = handoffDeps({ success: true });
    await handleCLISessionResume(resumeParams({ store, handoffService,
      callback: callback({ chatType: 'group', threadId: 'topic_b' }) }));
    expect(handoffService.acceptHandoff).not.toHaveBeenCalled();
  });

  it('does not revive a resume when /stop arrives during the access lookup', async () => {
    const guard = new PreparationGuard();
    const key: SessionKey = 'feishu:chat_1:ccbot';
    const store = storeDeps();
    const lookup = deferred<Array<ReturnType<typeof storedSession>>>();
    store.getSessionAccess.mockReturnValue(lookup.promise);
    const handoffService = handoffDeps({ success: true });
    const cancelAgent = vi.fn();
    const adapter = { send: vi.fn().mockResolvedValue('msg') };
    const pending = handleCLISessionResume(resumeParams({ store, handoffService, adapter,
      ensureReady: guard.capture(key), agentManager: { cancelAgent } }));
    await vi.waitFor(() => expect(store.getSessionAccess).toHaveBeenCalledOnce());
    guard.cancel(key);
    lookup.resolve([]);
    await pending;
    expect(handoffService.acceptHandoff).not.toHaveBeenCalled();
    expect(cancelAgent).not.toHaveBeenCalled();
    expect(store.updateWorkingDirectory).not.toHaveBeenCalled();
    expect(store.updateAgentSessionId).not.toHaveBeenCalled();
    expect(handoffService.releaseLock).toHaveBeenCalledWith(key);
    expect(adapter.send).toHaveBeenCalledWith('chat_1', { text: 'Resume failed: request stopped or no longer available' });
  });

  it('rechecks cancellation after directory validation and before cancelling the old process', async () => {
    const guard = new PreparationGuard();
    const key: SessionKey = 'feishu:chat_1:ccbot';
    const validation = deferred<boolean>();
    validatorMock.validateWorkingDirectory.mockReturnValue(validation.promise);
    const store = storeDeps();
    const handoffService = handoffDeps({ success: true });
    const cancelAgent = vi.fn();
    const pending = handleCLISessionResume(resumeParams({ store, handoffService,
      ensureReady: guard.capture(key), agentManager: { cancelAgent } }));
    await vi.waitFor(() => expect(validatorMock.validateWorkingDirectory).toHaveBeenCalledOnce());
    guard.cancel(key);
    validation.resolve(true);
    await pending;
    expect(handoffService.acceptHandoff).not.toHaveBeenCalled();
    expect(cancelAgent).not.toHaveBeenCalled();
    expect(store.updateAgentSessionId).not.toHaveBeenCalled();
  });

  it('does not update the session pointer when cancellation arrives as handoff completes', async () => {
    const guard = new PreparationGuard();
    const key: SessionKey = 'feishu:chat_1:ccbot';
    const store = storeDeps();
    const handoffService = handoffDeps({ success: true });
    handoffService.acceptHandoff.mockImplementation(async () => { guard.cancel(key); return { success: true }; });
    await handleCLISessionResume(resumeParams({ store, handoffService, ensureReady: guard.capture(key) }));
    expect(store.getOrCreate).not.toHaveBeenCalled();
    expect(store.updateWorkingDirectory).not.toHaveBeenCalled();
    expect(store.updateAgentSessionId).not.toHaveBeenCalled();
  });
});

function resumeParams(overrides: Partial<Parameters<typeof handleCLISessionResume>[0]> = {}): Parameters<typeof handleCLISessionResume>[0] {
  return {
    callback: callback(), resume: { sessionId: 'session_123', cwd: '/Users/test/project' },
    botName: 'ccbot', botConfig: botConfig(), adapter: { send: vi.fn().mockResolvedValue('msg_1') },
    store: storeDeps(), agentManager: { cancelAgent: vi.fn() }, handoffService: handoffDeps({ success: true }),
    cardController: undefined, tgStreamController: undefined, ...overrides,
  };
}

function callback(overrides: Partial<CallbackQuery> = {}): CallbackQuery {
  return {
    platform: 'feishu',
    chatId: 'chat_1',
    userId: 'ou_allowed',
    data: 'resume:session_123',
    messageId: 'msg_1',
    ...overrides,
  };
}

function botConfig(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    agent: 'claude-code',
    platform: 'feishu',
    feishu: { appId: 'cli_abc', appSecret: 'secret' },
    workingDirectory: '/Users/test/project',
    allowFrom: ['ou_allowed'],
    permissionMode: 'blacklist',
    ...overrides,
  };
}

function storedSession(agentName = 'claude-code', agentSessionId = 'session_123') {
  return { id: 'session_row_1', key: 'feishu:chat_1:ccbot' as SessionKey,
    agentName, agentSessionId, workingDirectory: '/Users/test/project',
    state: 'active' as const, createdAt: 0, lastActiveAt: 0 };
}

function storeDeps(agentName = 'claude-code', sessionId = 'session_123') {
  return {
    getByKey: vi.fn<() => Promise<ReturnType<typeof storedSession> | null>>().mockResolvedValue(storedSession(agentName, sessionId)),
    listByBot: vi.fn<() => Promise<Array<ReturnType<typeof storedSession>>>>().mockResolvedValue([]),
    getSessionAccess: vi.fn<() => Promise<Array<ReturnType<typeof storedSession>>>>().mockResolvedValue([]),
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
    acceptHandoff: vi.fn(async (_req: unknown, opts?: { beforeProceed?: () => void | Promise<void> }) => {
      if (result.success) await opts?.beforeProceed?.();
      return result;
    }),
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
    acceptHandoff: vi.fn(async (_req: unknown, opts?: { beforeProceed?: () => void | Promise<void> }) => {
      if (result.success) await opts?.beforeProceed?.();
      return result;
    }),
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
