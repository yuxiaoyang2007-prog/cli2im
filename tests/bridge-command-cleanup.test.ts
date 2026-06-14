import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleBridgeCommand } from '../src/index.js';
import { TelegramStreamController } from '../src/platforms/telegram/stream.js';
import { parseBridgeCommand } from '../src/pipeline.js';
import type { BotConfig, PlatformAdapter, SessionKey } from '../src/types.js';

const validatorMock = vi.hoisted(() => ({
  validateWorkingDirectory: vi.fn(),
}));

vi.mock('../src/security/validators.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/security/validators.js')>();
  return {
    ...actual,
    validateWorkingDirectory: validatorMock.validateWorkingDirectory,
  };
});

const sessionKey = 'telegram:chat_1:ccbot' as SessionKey;

describe('handleBridgeCommand lifecycle cleanup', () => {
  beforeEach(() => {
    validatorMock.validateWorkingDirectory.mockReset();
    validatorMock.validateWorkingDirectory.mockResolvedValue(true);
  });

  it('clears Telegram stream buffer on /new', async () => {
    const deps = commandDeps();
    deps.tgStreamController.appendText(sessionKey, 'chat_1', 'stale buffered text');

    await runCommand('new', [], deps);
    await deps.tgStreamController.finalize(sessionKey);

    expect(deps.adapter.send).toHaveBeenCalledTimes(1);
    expect(deps.voiceSessions.has(sessionKey)).toBe(false);
    expect(deps.adapter.send).not.toHaveBeenCalledWith('chat_1', {
      text: 'stale buffered text',
    });
  });

  it('handles /clear with the same reset behavior as /new for SDK bots', async () => {
    const deps = commandDeps({ existingSession: true });
    deps.tgStreamController.appendText(sessionKey, 'chat_1', 'stale buffered text');

    const command = parseBridgeCommand('/clear');
    expect(command).toEqual({ command: 'new', args: [] });
    await runCommand(command!.command, command!.args, deps);
    await deps.tgStreamController.finalize(sessionKey);

    expect(deps.agentManager.killAgent).toHaveBeenCalledWith(sessionKey);
    expect(deps.store.delete).toHaveBeenCalledWith('session_row_1');
    expect(deps.adapter.send).toHaveBeenCalledWith('chat_1', { text: '新会话已创建，发消息开始' });
    expect(deps.adapter.send).not.toHaveBeenCalledWith('chat_1', {
      text: 'stale buffered text',
    });
  });

  it('clears Telegram stream buffer on /cwd', async () => {
    const deps = commandDeps({ existingSession: true });
    deps.tgStreamController.appendText(sessionKey, 'chat_1', 'stale buffered text');
    const cwd = await mkdtemp(join(tmpdir(), 'cli2im-cwd-command-'));
    const cwdReal = await realpath(cwd);

    await runCommand('cwd', [cwd], deps);
    await deps.tgStreamController.finalize(sessionKey);

    expect(deps.adapter.send).toHaveBeenCalledTimes(1);
    expect(deps.store.updateWorkingDirectory).toHaveBeenCalledWith('session_row_1', cwdReal);
    expect(deps.voiceSessions.has(sessionKey)).toBe(false);
    expect(deps.adapter.send).not.toHaveBeenCalledWith('chat_1', {
      text: 'stale buffered text',
    });
  });

  it('clears Telegram stream buffer on /handoff', async () => {
    const deps = commandDeps();
    deps.tgStreamController.appendText(sessionKey, 'chat_1', 'stale buffered text');

    await runCommand('handoff', [], deps);
    await deps.tgStreamController.finalize(sessionKey);

    expect(deps.adapter.send).toHaveBeenCalledTimes(1);
    expect(deps.voiceSessions.has(sessionKey)).toBe(false);
    expect(deps.adapter.send).not.toHaveBeenCalledWith('chat_1', {
      text: 'stale buffered text',
    });
  });

  it('resumes with the bot configured agent and working directory', async () => {
    const deps = commandDeps({
      botConfig: {
        agent: 'claude-code-pty',
        workingDirectory: '/Users/test/project',
      },
    });

    await runCommand('resume', ['session_123'], deps);

    expect(deps.handoffService.acceptHandoff).toHaveBeenCalledWith({
      botName: 'ccbot',
      sessionId: 'session_123',
      workDir: '/Users/test/project',
      agentName: 'claude-code-pty',
      chatId: 'chat_1',
    });
    expect(deps.adapter.send).toHaveBeenCalledWith('chat_1', {
      text: expect.stringContaining('- 项目: `/Users/test/project`'),
    });
    expect(deps.adapter.send).toHaveBeenCalledWith('chat_1', {
      text: expect.stringContaining('- Agent: claude-code-pty'),
    });
  });

  it('force-approves the pending permission for the current session only', async () => {
    const deps = commandDeps();
    deps.agentManager.getPendingPermissionForSession.mockReturnValue({
      requestId: 'req_same',
      tool: 'Bash',
      command: 'sudo ls',
      chatId: 'chat_1',
      sessionKey,
      agentName: 'codex',
      timer: 0 as unknown as ReturnType<typeof setTimeout>,
      createdAt: 0,
    });
    deps.agentManager.approvePermission.mockReturnValue(true);

    await runCommand('force-approve', [], deps);

    expect(deps.agentManager.getPendingPermissionForSession).toHaveBeenCalledWith(sessionKey);
    expect(deps.agentManager.approvePermission).toHaveBeenCalledWith(sessionKey, 'req_same');
    expect(deps.adapter.send).toHaveBeenCalledWith('chat_1', { text: '已批准执行: `sudo ls`' });
  });
});

function commandDeps(opts: { existingSession?: boolean; botConfig?: Partial<BotConfig> } = {}) {
  const adapter = adapterStub();
  const tgStreamController = new TelegramStreamController(adapter);
  return {
    adapter,
    tgStreamController,
    voiceSessions: new Map<SessionKey, string>([[sessionKey, 'chat_1']]),
    store: {
      getByKey: vi.fn(async () => (
        opts.existingSession
          ? {
              id: 'session_row_1',
              key: sessionKey,
              agentName: 'codex',
              workingDirectory: '/Users/test/old-project',
              state: 'active' as const,
              createdAt: 0,
              lastActiveAt: 0,
            }
          : null
      )),
      delete: vi.fn(async () => undefined),
      updateWorkingDirectory: vi.fn(async () => undefined),
    },
    agentManager: {
      killAgent: vi.fn(),
      cancelAgent: vi.fn(),
      hasProcess: vi.fn(() => false),
      getPendingPermissionForSession: vi.fn(),
      approvePermission: vi.fn(),
    },
    handoffService: {
      acceptHandoff: vi.fn(async () => ({ success: true })),
      releaseHandoff: vi.fn(async () => ({
        sessionId: 'agent-session-1',
        resumeCommand: 'codex resume agent-session-1',
      })),
    },
    runtimeState: {
      fastModeBySession: new Map<SessionKey, boolean>(),
    },
    botConfig: {
      agent: 'codex',
      platform: 'telegram',
      telegram: { token: 'token' },
      workingDirectory: '/Users/test/project',
      allowFrom: ['user_1'],
      permissionMode: 'blacklist',
      ...opts.botConfig,
    } satisfies BotConfig,
  };
}

async function runCommand(
  command: string,
  args: string[],
  deps: ReturnType<typeof commandDeps>,
) {
  await handleBridgeCommand(
    { command, args },
    sessionKey,
    'ccbot',
    'chat_1',
    deps.adapter,
    deps.store as never,
    deps.agentManager as never,
    deps.handoffService as never,
    undefined,
    deps.tgStreamController,
    deps.voiceSessions,
    deps.runtimeState,
    deps.botConfig,
  );
}

function adapterStub(): PlatformAdapter {
  return {
    name: 'telegram',
    connect: vi.fn(),
    disconnect: vi.fn(),
    onMessage: vi.fn(),
    send: vi.fn(async () => 'msg_1'),
    editMessage: vi.fn(),
    deleteMessage: vi.fn(),
    sendFile: vi.fn(),
  };
}
