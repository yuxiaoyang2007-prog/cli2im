import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleBridgeCommand } from '../src/index.js';
import type { BotConfig, PlatformAdapter, SessionKey } from '../src/types.js';

const scannerMocks = vi.hoisted(() => ({
  cliScan: vi.fn(),
  codexScan: vi.fn(),
  geminiScan: vi.fn(),
  antigravityScan: vi.fn(),
}));

vi.mock('../src/session/cli-scanner.js', () => ({
  CLISessionScanner: vi.fn(function () { return { scan: scannerMocks.cliScan }; }),
}));
vi.mock('../src/session/codex-scanner.js', () => ({
  CodexSessionScanner: vi.fn(function () { return { scan: scannerMocks.codexScan }; }),
}));
vi.mock('../src/session/gemini-scanner.js', () => ({
  GeminiSessionScanner: vi.fn(function () { return { scan: scannerMocks.geminiScan }; }),
}));
vi.mock('../src/session/antigravity-scanner.js', () => ({
  AntigravitySessionScanner: vi.fn(function () { return { scan: scannerMocks.antigravityScan }; }),
}));

const sessionKey = 'telegram:chat_1:ccbot' as SessionKey;

describe('/sessions command scanner selection', () => {
  beforeEach(() => {
    scannerMocks.cliScan.mockReset();
    scannerMocks.codexScan.mockReset();
    scannerMocks.geminiScan.mockReset();
    scannerMocks.antigravityScan.mockReset();
    scannerMocks.cliScan.mockResolvedValue([session('claude-session')]);
    scannerMocks.codexScan.mockResolvedValue([session('codex-session')]);
    scannerMocks.geminiScan.mockResolvedValue([session('gemini-session')]);
    scannerMocks.antigravityScan.mockResolvedValue([session('antigravity-session')]);
  });

  it('scans compatible histories and filters before limiting the displayed list', async () => {
    const sdkDeps = commandDeps({
      botConfig: botConfig({
        agent: 'claude-code',
        workingDirectory: '/Users/test/project',
      }),
    });
    await runCommand('sessions', [], sdkDeps);
    expect(scannerMocks.cliScan).toHaveBeenLastCalledWith({ limit: Number.MAX_SAFE_INTEGER });

    const codexDeps = commandDeps({
      botConfig: botConfig({
        agent: 'codex',
        workingDirectory: '/Users/test/project',
      }),
    });
    await runCommand('sessions', [], codexDeps);
    expect(scannerMocks.codexScan).toHaveBeenLastCalledWith({ limit: Number.MAX_SAFE_INTEGER });
  });

  it('treats agy default /sessions as Antigravity, not Gemini', async () => {
    const deps = commandDeps({
      botConfig: botConfig({
        agent: 'agy',
        workingDirectory: '/Users/test/agy-bot',
      }),
    });

    await runCommand('sessions', [], deps);

    expect(scannerMocks.antigravityScan).toHaveBeenCalledWith({ limit: Number.MAX_SAFE_INTEGER });
    expect(scannerMocks.geminiScan).not.toHaveBeenCalled();
    expect(scannerMocks.cliScan).not.toHaveBeenCalled();
    expect(scannerMocks.codexScan).not.toHaveBeenCalled();
  });

  it('rejects alternate agent history in a bot that cannot resume it', async () => {
    const deps = commandDeps({
      botConfig: botConfig({
        agent: 'agy',
        workingDirectory: '/Users/test/agy-bot',
      }),
    });

    await runCommand('sessions', ['gemini'], deps);

    expect(scannerMocks.geminiScan).not.toHaveBeenCalled();
    expect(scannerMocks.antigravityScan).not.toHaveBeenCalled();
    expect(scannerMocks.cliScan).not.toHaveBeenCalled();
    expect(scannerMocks.codexScan).not.toHaveBeenCalled();
    expect(deps.adapter.send).toHaveBeenCalledWith('chat_1', { text: '请在对应 AI 的机器人中查看历史对话' });
  });

  it('does not reveal unrelated titles to ordinary users even in the same project', async () => {
    const deps = commandDeps({ botConfig: botConfig({ adminUsers: [] }) });
    scannerMocks.cliScan.mockResolvedValue([{ ...session('private-session'), title: 'OTHER_USER_PRIVATE_TITLE' }, session('mine')]);
    deps.store.listSessionAccess.mockResolvedValue([{ key: sessionKey, agentName: 'claude-code', agentSessionId: 'mine', workingDirectory: '/Users/test/project' }]);
    await runCommand('sessions', [], deps);
    const sent = JSON.stringify(vi.mocked(deps.adapter.send).mock.calls);
    expect(sent).toContain('mine');
    expect(sent).not.toContain('OTHER_USER_PRIVATE_TITLE');
    expect(sent).not.toContain('private-session');
  });

  it('filters same-bot active sessions by scope for ordinary users', async () => {
    const deps = commandDeps({ botConfig: botConfig({ adminUsers: [] }) });
    deps.store.listByBot.mockResolvedValue([
      { key: sessionKey, agentName: 'claude-code', agentSessionId: 'mine', workingDirectory: '/mine' },
      { key: 'telegram:other:ccbot', agentName: 'claude-code', agentSessionId: 'private-id', workingDirectory: '/private-project' },
    ]);
    await runCommand('sessions', ['bot'], deps);
    const sent = JSON.stringify(vi.mocked(deps.adapter.send).mock.calls);
    expect(sent).toContain('mine');
    expect(sent).not.toContain('private-id');
    expect(sent).not.toContain('/private-project');
  });

  it('lets the named owner see compatible desktop histories', async () => {
    const deps = commandDeps({ botConfig: botConfig({}) });
    scannerMocks.cliScan.mockResolvedValue([session('desktop-session')]);
    await runCommand('sessions', [], deps);
    expect(JSON.stringify(vi.mocked(deps.adapter.send).mock.calls)).toContain('desktop-session');
  });
});

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
    deps.tgStreamController as never,
    deps.voiceSessions,
    deps.runtimeState,
    deps.botConfig,
    { platform: 'telegram', userId: 'user_1', chatType: 'private' },
  );
}

function commandDeps(opts: { botConfig: BotConfig }) {
  return {
    adapter: adapterStub(),
    store: {
      listByBot: vi.fn<() => Promise<any[]>>().mockResolvedValue([]),
      getByKey: vi.fn(),
      listSessionAccess: vi.fn<() => Promise<any[]>>().mockResolvedValue([]),
    },
    agentManager: {
      hasProcess: vi.fn(() => false),
      getPlugin: vi.fn(() => ({ displayName: opts.botConfig.agent })),
    },
    handoffService: {},
    tgStreamController: undefined,
    voiceSessions: new Map<SessionKey, string>(),
    runtimeState: {
      fastModeBySession: new Map<SessionKey, boolean>(),
    },
    botConfig: opts.botConfig,
  };
}

function botConfig(overrides: Partial<BotConfig>): BotConfig {
  return {
    agent: 'claude-code',
    platform: 'telegram',
    telegram: { token: 'token' },
    workingDirectory: '/Users/test/project',
    allowFrom: ['user_1'],
    adminUsers: ['user_1'],
    permissionMode: 'blacklist',
    ...overrides,
  };
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

function session(sessionId: string) {
  return {
    sessionId,
    cwd: '/Users/test/project',
    title: 'Test session',
    lastModified: Date.now(),
    status: 'historical' as const,
  };
}
