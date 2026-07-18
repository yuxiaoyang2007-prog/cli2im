import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HandoffService } from '../src/services/handoff.js';

describe('HandoffService', () => {
  let service: HandoffService;
  let mockSpawnResume: ReturnType<typeof vi.fn>;
  let mockGetSession: ReturnType<typeof vi.fn>;
  let mockUpdateState: ReturnType<typeof vi.fn>;
  let mockGetAgentCapabilities: ReturnType<typeof vi.fn>;
  let mockGetBotAgent: ReturnType<typeof vi.fn>;

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
