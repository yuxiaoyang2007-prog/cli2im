import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HandoffService } from '../src/services/handoff.js';
import { PreparationGuard } from '../src/runtime/preparation-guard.js';

describe('HandoffService', () => {
  let service: HandoffService;
  type HandoffDeps = ConstructorParameters<typeof HandoffService>[0];
  let mockSpawnResume: ReturnType<typeof vi.fn<HandoffDeps['spawnResume']>>;
  let mockGetSession: ReturnType<typeof vi.fn<HandoffDeps['getSession']>>;
  let mockUpdateState: ReturnType<typeof vi.fn<HandoffDeps['updateState']>>;
  let mockGetAgentCapabilities: ReturnType<typeof vi.fn<NonNullable<HandoffDeps['getAgentCapabilities']>>>;
  let mockGetBotAgent: ReturnType<typeof vi.fn<NonNullable<HandoffDeps['getBotAgent']>>>;

  beforeEach(() => {
    mockSpawnResume = vi.fn().mockResolvedValue({ pid: 123, sessionId: 'ses_abc' });
    mockGetSession = vi.fn().mockResolvedValue({
      id: 'uuid-1',
      key: 'feishu:oc_xxx:ccbot',
      agentName: 'claude-code',
      agentSessionId: 'ses_abc',
      workingDirectory: '~/projects',
      state: 'active',
    });
    mockUpdateState = vi.fn().mockResolvedValue(undefined);
    mockGetAgentCapabilities = vi.fn().mockReturnValue({ sessionResume: true });
    mockGetBotAgent = vi.fn().mockReturnValue('claude-code');

    service = new HandoffService({
      spawnResume: mockSpawnResume,
      getSession: mockGetSession,
      updateState: mockUpdateState,
      getAgentCapabilities: mockGetAgentCapabilities,
      getBotAgent: mockGetBotAgent,
    });
  });

  it('isHandoffInProgress returns false initially', () => {
    expect(service.isHandoffInProgress('feishu:oc_xxx:ccbot')).toBe(false);
  });

  it('acceptHandoff sets lock and resolves', async () => {
    const result = await service.acceptHandoff({
      botName: 'ccbot',
      sessionId: 'ses_abc',
      workDir: '~/projects/NewsRadar',
      agentName: 'claude-code',
      chatId: 'oc_xxx',
    });

    expect(result.success).toBe(true);
  });

  it('returns a generic error when spawnResume throws without leaking the message', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockSpawnResume.mockRejectedValue(new Error('/Users/test/secret-path spawn failed'));

    try {
      const result = await service.acceptHandoff({
        botName: 'ccbot',
        sessionId: 'ses_abc',
        workDir: '~/projects/NewsRadar',
        agentName: 'claude-code',
        chatId: 'oc_xxx',
      });

      expect(result).toEqual({ success: false, error: 'Handoff failed' });
      expect(result.error).not.toContain('/Users/test/secret-path');
      expect(consoleError).toHaveBeenCalled();
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain('/Users/test/secret-path');
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain('oc_xxx');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('releaseHandoff returns resume command', async () => {
    const result = await service.releaseHandoff('feishu:oc_xxx:ccbot');
    expect(result.sessionId).toBe('ses_abc');
    expect(result.resumeCommand).toContain('--resume');
    expect(result.resumeCommand).toContain('ses_abc');
    expect(mockUpdateState).toHaveBeenCalledWith('uuid-1', 'handed_off');
  });

  it('rejects accept before lock, callback, or spawn when the requested agent cannot resume', async () => {
    mockGetAgentCapabilities.mockReturnValue({ sessionResume: false });
    mockGetBotAgent.mockReturnValue('kimi-work');
    const beforeProceed = vi.fn();

    const result = await service.acceptHandoff({
      botName: 'kimibot',
      sessionId: 'old-session',
      workDir: '/tmp',
      agentName: 'kimi-work',
      chatId: 'chat_1',
    }, { beforeProceed });

    expect(result).toEqual({ success: false, error: '该 agent 不支持会话恢复/交接' });
    expect(beforeProceed).not.toHaveBeenCalled();
    expect(mockSpawnResume).not.toHaveBeenCalled();
    expect(service.isHandoffInProgress('feishu:chat_1:kimibot')).toBe(false);
  });

  it('uses the same encoded topic scope as messages and callbacks', async () => {
    service.tryAcquireLock('feishu:chat_1:ccbot:topic%3A1');
    const result = await service.acceptHandoff({ botName: 'ccbot', agentName: 'claude-code',
      sessionId: 'ses_abc', workDir: '/tmp', chatId: 'chat_1', threadId: 'topic:1' }, { lockAlreadyAcquired: true });
    expect(result.success).toBe(true);
    expect(mockSpawnResume).toHaveBeenCalledWith('feishu:chat_1:ccbot:topic%3A1', 'claude-code', 'ses_abc', '/tmp');
  });

  it('rejects a caller-supplied platform that differs from the target bot', async () => {
    const beforeProceed = vi.fn();
    const platformService = new HandoffService({ spawnResume: mockSpawnResume, getSession: mockGetSession,
      updateState: mockUpdateState, getBotPlatform: () => 'feishu' });
    const result = await platformService.acceptHandoff({ botName: 'ccbot', agentName: 'claude-code',
      platform: 'telegram', sessionId: 'ses_abc', workDir: '/tmp', chatId: 'chat' }, { beforeProceed });
    expect(result).toEqual({ success: false, error: 'Platform does not match bot configuration' });
    expect(beforeProceed).not.toHaveBeenCalled();
    expect(mockSpawnResume).not.toHaveBeenCalled();
    expect(platformService.isHandoffInProgress('telegram:chat:ccbot')).toBe(false);
  });

  it('does not spawn after cancellation during an asynchronous beforeProceed', async () => {
    const guard = new PreparationGuard();
    const key = 'feishu:chat:ccbot';
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const beforeProceed = vi.fn(async () => { await barrier; });
    const pending = service.acceptHandoff({ botName: 'ccbot', agentName: 'claude-code',
      sessionId: 'ses_abc', workDir: '/tmp', chatId: 'chat' }, { beforeProceed, ensureReady: guard.capture(key) });
    await vi.waitFor(() => expect(beforeProceed).toHaveBeenCalledOnce());
    guard.cancel(key);
    release();
    expect(await pending).toEqual({ success: false, error: 'Handoff failed' });
    expect(mockSpawnResume).not.toHaveBeenCalled();
    expect(service.isHandoffInProgress(key)).toBe(false);
  });

  it('passes the captured cancellation check down to the spawn implementation', async () => {
    const ensureReady = vi.fn();
    const result = await service.acceptHandoff({ botName: 'ccbot', agentName: 'claude-code',
      sessionId: 'ses_abc', workDir: '/tmp', chatId: 'chat' }, { ensureReady });
    expect(result.success).toBe(true);
    expect(mockSpawnResume).toHaveBeenCalledWith('feishu:chat:ccbot', 'claude-code', 'ses_abc', '/tmp', ensureReady);
  });

  it('rejects a request invalidated before entry without acquiring a lock or running cleanup', async () => {
    const beforeProceed = vi.fn();
    const result = await service.acceptHandoff({ botName: 'ccbot', agentName: 'claude-code',
      sessionId: 'ses_abc', workDir: '/tmp', chatId: 'chat' }, { beforeProceed,
      ensureReady: () => { throw new Error('private cancellation detail'); } });
    expect(result).toEqual({ success: false, error: 'Handoff failed' });
    expect(beforeProceed).not.toHaveBeenCalled();
    expect(mockSpawnResume).not.toHaveBeenCalled();
    expect(service.isHandoffInProgress('feishu:chat:ccbot')).toBe(false);
  });

  it('reserves the actual agent session across different chats during handoff', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mockSpawnResume.mockImplementation(async () => { await gate; return { pid: 123, sessionId: 'ses_abc' }; });
    const first = service.acceptHandoff({ botName: 'ccbot', agentName: 'claude-code',
      sessionId: 'ses_abc', workDir: '/tmp', chatId: 'chat_one' });
    await vi.waitFor(() => expect(mockSpawnResume).toHaveBeenCalledTimes(1));
    const second = await service.acceptHandoff({ botName: 'ccbot', agentName: 'claude-code',
      sessionId: 'ses_abc', workDir: '/tmp', chatId: 'chat_two' });
    expect(second.success).toBe(false);
    expect(mockSpawnResume).toHaveBeenCalledTimes(1);
    release();
    expect((await first).success).toBe(true);
  });

  it('rejects an already running agent session in a different scope before touching the old process', async () => {
    const beforeProceed = vi.fn();
    const isSessionBusy = vi.fn(() => true);
    const busyService = new HandoffService({ spawnResume: mockSpawnResume, getSession: mockGetSession,
      updateState: mockUpdateState, isSessionBusy });
    const result = await busyService.acceptHandoff({ botName: 'ccbot', agentName: 'claude-code',
      sessionId: 'ses_abc', workDir: '/tmp', chatId: 'chat_two' }, { beforeProceed });
    expect(result.success).toBe(false);
    expect(isSessionBusy).toHaveBeenCalledWith('claude-code', 'ses_abc', 'feishu:chat_two:ccbot');
    expect(beforeProceed).not.toHaveBeenCalled();
    expect(mockSpawnResume).not.toHaveBeenCalled();
  });

  it('runs beforeProceed after the capability gate and before spawn', async () => {
    const beforeProceed = vi.fn();

    const result = await service.acceptHandoff({
      botName: 'ccbot',
      sessionId: 'ses_abc',
      workDir: '/tmp',
      agentName: 'claude-code',
      chatId: 'chat_1',
    }, { beforeProceed });

    expect(result.success).toBe(true);
    expect(beforeProceed).toHaveBeenCalledTimes(1);
    expect(beforeProceed.mock.invocationCallOrder[0]).toBeLessThan(mockSpawnResume.mock.invocationCallOrder[0]);
  });

  it('rejects release using the current bot agent even when the stored agentName is stale', async () => {
    mockGetSession.mockResolvedValue({
      id: 'uuid-1',
      key: 'feishu:chat_1:kimibot',
      agentName: 'claude-code',
      agentSessionId: 'stale-session',
      workingDirectory: '/tmp',
      state: 'active',
      createdAt: 0,
      lastActiveAt: 0,
    });
    mockGetBotAgent.mockReturnValue('kimi-work');
    mockGetAgentCapabilities.mockImplementation((agentName: string) => ({
      sessionResume: agentName !== 'kimi-work',
    }));

    await expect(service.releaseHandoff('feishu:chat_1:kimibot')).rejects.toThrow(
      '该 agent 不支持会话恢复/交接',
    );
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockUpdateState).not.toHaveBeenCalled();
  });
});
