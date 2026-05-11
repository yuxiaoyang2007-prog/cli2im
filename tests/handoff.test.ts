import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HandoffService } from '../src/services/handoff.js';

describe('HandoffService', () => {
  let service: HandoffService;
  let mockSpawnResume: ReturnType<typeof vi.fn>;
  let mockGetSession: ReturnType<typeof vi.fn>;
  let mockUpdateState: ReturnType<typeof vi.fn>;

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

    service = new HandoffService({
      spawnResume: mockSpawnResume,
      getSession: mockGetSession,
      updateState: mockUpdateState,
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
});
