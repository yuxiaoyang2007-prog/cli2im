import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EventEmitter, Readable, Transform, Writable } from 'node:stream';
import { AgentManager, type AgentManagerEvents } from '../src/agents/manager.js';
import { ToolGate } from '../src/agents/tool-gate.js';
import { HandoffService } from '../src/services/handoff.js';
import { HttpServer } from '../src/services/server.js';
import { handleCLISessionResume } from '../src/runtime/session-resume.js';
import { bindSessionScopedBufferCleanup } from '../src/runtime/session-scoped-cleanup.js';
import type {
  AgentPlugin,
  AgentProcess,
  BotConfig,
  CallbackQuery,
  SessionKey,
} from '../src/types.js';

const validatorMock = vi.hoisted(() => ({
  validateWorkingDirectory: vi.fn(),
}));

vi.mock('../src/security/validators.js', () => ({
  validateWorkingDirectory: validatorMock.validateWorkingDirectory,
}));

describe('session-scoped cleanup across spawn/resume entrypoints', () => {
  beforeEach(() => {
    validatorMock.validateWorkingDirectory.mockReset();
    validatorMock.validateWorkingDirectory.mockImplementation(async (path: string) => path.startsWith('/Users/'));
  });

  it('protects the /resume callback path through HandoffService -> AgentManager.resumeAgent', async () => {
    const sessionKey = 'feishu:chat_1:ccbot' as SessionKey;
    const harness = createHarness();
    const adapter = { send: vi.fn().mockResolvedValue('msg_1') };

    await handleCLISessionResume({
      callback: callback(),
      resume: { sessionId: 'session_123', cwd: '/Users/test/project' },
      botName: 'ccbot',
      botConfig: botConfig(),
      adapter,
      store: storeDeps(),
      agentManager: harness.manager,
      handoffService: harness.handoffService,
      cardController: undefined,
      tgStreamController: harness.tgStreamController,
    });

    harness.tgStreamController.interrupt.mockClear();
    harness.voiceSessions.set(sessionKey, 'chat_1');

    harness.manager.cancelAgent(sessionKey);

    expect(harness.voiceSessions.has(sessionKey)).toBe(false);
    expect(harness.tgStreamController.interrupt).toHaveBeenCalledWith(sessionKey);
  });

  it('protects the HTTP handoff path through HandoffService -> AgentManager.resumeAgent', async () => {
    const sessionKey = 'telegram:chat_1:ccbot' as SessionKey;
    const harness = createHarness();
    const server = new HttpServer('secret-token', {
      acceptHandoff: (req) => harness.handoffService.acceptHandoff(req),
      releaseHandoff: vi.fn().mockResolvedValue({ sessionId: 'session_123', resumeCommand: 'mock --resume session_123' }),
      getStatus: () => ({ uptime: 1, activeSessions: 0, bots: ['ccbot'] }),
    }, {
      botNames: ['ccbot'],
      agentNames: ['mock-agent'],
    });

    await server.start('127.0.0.1', 0);
    try {
      const res = await postHandoff(server, {
        botName: 'ccbot',
        sessionId: 'session_123',
        workDir: '/Users/test/project',
        agentName: 'mock-agent',
        chatId: 'chat_1',
        platform: 'telegram',
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });

      harness.voiceSessions.set(sessionKey, 'chat_1');
      harness.manager.cancelAgent(sessionKey);

      expect(harness.voiceSessions.has(sessionKey)).toBe(false);
      expect(harness.tgStreamController.interrupt).toHaveBeenCalledWith(sessionKey);
    } finally {
      await server.stop();
    }
  });
});

function createHarness() {
  const voiceSessions = new Map<SessionKey, string>();
  const tgStreamController = { interrupt: vi.fn() };
  const manager = new AgentManager(new ToolGate([]), (signal, sessionKey) => {
    bindSessionScopedBufferCleanup(signal, sessionKey, {
      voiceSessions,
      tgStreamController,
    });
  });
  manager.registerPlugin(createMockPlugin());

  const handoffService = new HandoffService({
    spawnResume: async (sessionKey, agentName, sessionId, workDir) => {
      const proc = await manager.resumeAgent(
        sessionKey,
        agentName,
        sessionId,
        { workingDirectory: workDir, permissionMode: 'blacklist' },
        handlersStub(),
      );
      return { pid: proc.pid, sessionId };
    },
    getSession: vi.fn().mockResolvedValue(null),
    updateState: vi.fn().mockResolvedValue(undefined),
  });

  return { manager, voiceSessions, tgStreamController, handoffService };
}

function createMockPlugin(): AgentPlugin {
  return {
    name: 'mock-agent',
    displayName: 'Mock Agent',
    capabilities: {
      streamJson: true,
      permissionPrompt: true,
      sessionResume: true,
      gracefulCancel: true,
      slashCommands: [],
    },
    preflight: vi.fn().mockResolvedValue({ ok: true, version: '1.0.0' }),
    spawn: vi.fn().mockImplementation(() => createMockProcess()),
    resume: vi.fn().mockImplementation(() => createMockProcess()),
    buildSpawnArgs: vi.fn().mockReturnValue(['--test']),
    createStdoutParser: vi.fn().mockImplementation(() => new Transform({
      objectMode: true,
      transform(chunk, _, cb) { cb(null, chunk); },
    })),
    formatStdinMessage: vi.fn().mockImplementation((msg) => JSON.stringify(msg) + '\n'),
    formatPermissionResponse: vi.fn().mockImplementation((id, d) => JSON.stringify({ id, d }) + '\n'),
    formatCancelMessage: vi.fn().mockReturnValue('cancel\n'),
  };
}

function createMockProcess(): AgentProcess {
  const stdin = new Writable({ write(_, __, cb) { cb(); } });
  const stdout = new Readable({ objectMode: true, read() {} });
  const ee = new EventEmitter();
  return {
    pid: 12345,
    sessionId: '',
    stdin,
    stdout,
    kill: vi.fn(),
    on: (event: 'exit' | 'error', handler: ((code: number | null) => void) | ((err: Error) => void)) => {
      ee.on(event, handler as (...args: unknown[]) => void);
    },
  };
}

function handlersStub(): AgentManagerEvents {
  return {
    onEvent: vi.fn(),
    onToolBlocked: vi.fn(),
    onPermissionTimeout: vi.fn(),
    onProcessExit: vi.fn(),
  };
}

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
    agent: 'mock-agent',
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

async function postHandoff(server: HttpServer, body: Record<string, unknown>): Promise<Response> {
  const address = (server as unknown as { server: { address: () => { port: number } } }).server.address();
  return fetch(`http://127.0.0.1:${address.port}/api/handoff/accept`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer secret-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}
