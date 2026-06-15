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
  CLISessionScanner: vi.fn(() => ({
    scan: scannerMocks.cliScan,
  })),
}));
vi.mock('../src/session/codex-scanner.js', () => ({
  CodexSessionScanner: vi.fn(() => ({
    scan: scannerMocks.codexScan,
  })),
}));
vi.mock('../src/session/gemini-scanner.js', () => ({
  GeminiSessionScanner: vi.fn(() => ({
    scan: scannerMocks.geminiScan,
  })),
}));
vi.mock('../src/session/antigravity-scanner.js', () => ({
  AntigravitySessionScanner: vi.fn(() => ({
    scan: scannerMocks.antigravityScan,
  })),
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

  it('passes cwdFilter only for the claude-code-pty bot default /sessions path', async () => {
    const deps = commandDeps({
      botConfig: botConfig({
        agent: 'claude-code-pty',
        workingDirectory: '/Users/test/project',
      }),
    });

    await runCommand('sessions', [], deps);

    expect(scannerMocks.cliScan).toHaveBeenCalledWith({ cwdFilter: '/Users/test/project' });
    expect(scannerMocks.codexScan).not.toHaveBeenCalled();
    expect(scannerMocks.geminiScan).not.toHaveBeenCalled();
  });

  it('keeps SDK Claude and Codex /sessions scanner calls unfiltered', async () => {
    const sdkDeps = commandDeps({
      botConfig: botConfig({
        agent: 'claude-code',
        workingDirectory: '/Users/test/project',
      }),
    });
    await runCommand('sessions', [], sdkDeps);
    expect(scannerMocks.cliScan).toHaveBeenLastCalledWith();

    const codexDeps = commandDeps({
      botConfig: botConfig({
        agent: 'codex',
        workingDirectory: '/Users/test/project',
      }),
    });
    await runCommand('sessions', [], codexDeps);
    expect(scannerMocks.codexScan).toHaveBeenLastCalledWith();
  });

  it('treats agy default /sessions as Antigravity, not Gemini', async () => {
    const deps = commandDeps({
      botConfig: botConfig({
        agent: 'agy',
        workingDirectory: '/Users/test/agy-bot',
      }),
    });

    await runCommand('sessions', [], deps);

    expect(scannerMocks.antigravityScan).toHaveBeenCalledWith();
    expect(scannerMocks.geminiScan).not.toHaveBeenCalled();
    expect(scannerMocks.cliScan).not.toHaveBeenCalled();
    expect(scannerMocks.codexScan).not.toHaveBeenCalled();
  });

  it('keeps explicit Gemini /sessions requests on the Gemini scanner', async () => {
    const deps = commandDeps({
      botConfig: botConfig({
        agent: 'agy',
        workingDirectory: '/Users/test/agy-bot',
      }),
    });

    await runCommand('sessions', ['gemini'], deps);

    expect(scannerMocks.geminiScan).toHaveBeenCalledWith();
    expect(scannerMocks.antigravityScan).not.toHaveBeenCalled();
    expect(scannerMocks.cliScan).not.toHaveBeenCalled();
    expect(scannerMocks.codexScan).not.toHaveBeenCalled();
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
  );
}

function commandDeps(opts: { botConfig: BotConfig }) {
  return {
    adapter: adapterStub(),
    store: {
      listByBot: vi.fn(),
      getByKey: vi.fn(),
    },
    agentManager: {
      hasProcess: vi.fn(() => false),
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
