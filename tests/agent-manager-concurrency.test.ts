import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AgentManager } from '../src/agents/manager.js';
import { ToolGate } from '../src/agents/tool-gate.js';
import type { AgentPlugin, AgentProcess } from '../src/types.js';
import { EventEmitter, Readable, Transform, Writable } from 'node:stream';

const validatorMock = vi.hoisted(() => ({
  validateWorkingDirectory: vi.fn(),
}));

vi.mock('../src/security/validators.js', () => ({
  validateWorkingDirectory: validatorMock.validateWorkingDirectory,
}));

type MockAgentProcess = AgentProcess & {
  label: string;
  pushEvent: (event: unknown) => void;
  emitExit: (code: number | null) => void;
};

describe('AgentManager concurrent start claims', () => {
  let manager: AgentManager;
  let plugin: AgentPlugin;
  let processId: number;

  beforeEach(() => {
    manager = new AgentManager(new ToolGate([]), () => {});
    processId = 0;
    validatorMock.validateWorkingDirectory.mockReset();
    plugin = createMockPlugin(() => createMockProcess(`proc_${++processId}`));
    manager.registerPlugin(plugin);
  });

  it('does not let an older spawn overwrite a newer spawn when validation resolves out of order', async () => {
    const firstValidation = deferred<boolean>();
    const secondValidation = deferred<boolean>();
    validatorMock.validateWorkingDirectory
      .mockReturnValueOnce(firstValidation.promise)
      .mockReturnValueOnce(secondValidation.promise);
    const handlers = handlersStub();
    const sessionKey = 'feishu:chat_1:mock-agent' as const;

    const firstSpawn = manager.spawnAgent(
      sessionKey,
      'mock-agent',
      { workingDirectory: '/Users/test/first', permissionMode: 'blacklist' },
      handlers,
    );
    const secondSpawn = manager.spawnAgent(
      sessionKey,
      'mock-agent',
      { workingDirectory: '/Users/test/second', permissionMode: 'blacklist' },
      handlers,
    );

    secondValidation.resolve(true);
    const secondProc = await secondSpawn;
    firstValidation.resolve(true);

    await expect(firstSpawn).rejects.toThrow(/superseded/i);
    expect(manager.getProcess(sessionKey)).toBe(secondProc);
    expect(plugin.spawn).toHaveBeenCalledTimes(1);
  });

  it('does not let an older resume overwrite a newer resume when validation resolves out of order', async () => {
    const firstValidation = deferred<boolean>();
    const secondValidation = deferred<boolean>();
    validatorMock.validateWorkingDirectory
      .mockReturnValueOnce(firstValidation.promise)
      .mockReturnValueOnce(secondValidation.promise);
    const handlers = handlersStub();
    const sessionKey = 'feishu:chat_1:mock-agent' as const;

    const firstResume = manager.resumeAgent(
      sessionKey,
      'mock-agent',
      'agent-session-old',
      { workingDirectory: '/Users/test/first', permissionMode: 'blacklist' },
      handlers,
    );
    const secondResume = manager.resumeAgent(
      sessionKey,
      'mock-agent',
      'agent-session-new',
      { workingDirectory: '/Users/test/second', permissionMode: 'blacklist' },
      handlers,
    );

    secondValidation.resolve(true);
    const secondProc = await secondResume;
    firstValidation.resolve(true);

    await expect(firstResume).rejects.toThrow(/superseded/i);
    expect(manager.getProcess(sessionKey)).toBe(secondProc);
    expect(plugin.resume).toHaveBeenCalledTimes(1);
    expect(plugin.resume).toHaveBeenCalledWith('agent-session-new', {
      workingDirectory: '/Users/test/second',
      permissionMode: 'blacklist',
    });
  });

  it('keeps the previous process when a replacement claim fails validation before it exits', async () => {
    validatorMock.validateWorkingDirectory.mockResolvedValueOnce(true);
    const handlers = handlersStub();
    const sessionKey = 'feishu:chat_1:mock-agent' as const;
    const original = await manager.spawnAgent(
      sessionKey,
      'mock-agent',
      { workingDirectory: '/Users/test/original', permissionMode: 'blacklist' },
      handlers,
    );

    validatorMock.validateWorkingDirectory.mockResolvedValueOnce(false);

    await expect(manager.spawnAgent(
      sessionKey,
      'mock-agent',
      { workingDirectory: '/etc', permissionMode: 'blacklist' },
      handlers,
    )).rejects.toThrow('Invalid working directory');
    expect(manager.getProcess(sessionKey)).toBe(original);
  });

  it('does not restore the previous process if it exits while a replacement claim is validating', async () => {
    validatorMock.validateWorkingDirectory.mockResolvedValueOnce(true);
    const validation = deferred<boolean>();
    const onProcessExit = vi.fn();
    const handlers = { ...handlersStub(), onProcessExit };
    const sessionKey = 'feishu:chat_1:mock-agent' as const;
    const original = await manager.spawnAgent(
      sessionKey,
      'mock-agent',
      { workingDirectory: '/Users/test/original', permissionMode: 'blacklist' },
      handlers,
    ) as MockAgentProcess;

    validatorMock.validateWorkingDirectory.mockReturnValueOnce(validation.promise);
    const replacement = manager.spawnAgent(
      sessionKey,
      'mock-agent',
      { workingDirectory: '/etc', permissionMode: 'blacklist' },
      handlers,
    );

    original.emitExit(0);
    validation.resolve(false);

    await expect(replacement).rejects.toThrow('Invalid working directory');
    expect(manager.getProcess(sessionKey)).toBeUndefined();
    expect(onProcessExit).toHaveBeenCalledWith(sessionKey, 0, expect.any(Object));
  });

  it('passes the aborted previous context when a process exits during a replacement claim', async () => {
    validatorMock.validateWorkingDirectory.mockResolvedValueOnce(true);
    const validation = deferred<boolean>();
    const onProcessExit = vi.fn();
    const handlers = { ...handlersStub(), onProcessExit };
    const sessionKey = 'feishu:chat_1:mock-agent' as const;
    const original = await manager.spawnAgent(
      sessionKey,
      'mock-agent',
      { workingDirectory: '/Users/test/original', permissionMode: 'blacklist' },
      handlers,
    ) as MockAgentProcess;

    validatorMock.validateWorkingDirectory.mockReturnValueOnce(validation.promise);
    const replacement = manager.spawnAgent(
      sessionKey,
      'mock-agent',
      { workingDirectory: '/etc', permissionMode: 'blacklist' },
      handlers,
    );

    original.emitExit(1);

    expect(onProcessExit).toHaveBeenCalledTimes(1);
    const exitContext = onProcessExit.mock.calls[0][2];
    expect(exitContext.signal.aborted).toBe(true);
    expect(exitContext.isCurrent()).toBe(false);

    validation.resolve(false);
    await expect(replacement).rejects.toThrow('Invalid working directory');
  });

  it('passes the current context before disposal when the active process exits', async () => {
    validatorMock.validateWorkingDirectory.mockResolvedValueOnce(true);
    let signalWasAborted: boolean | undefined;
    let contextWasCurrent: boolean | undefined;
    const onProcessExit = vi.fn((_sessionKey, _code, exitContext) => {
      signalWasAborted = exitContext.signal.aborted;
      contextWasCurrent = exitContext.isCurrent();
    });
    const handlers = { ...handlersStub(), onProcessExit };
    const sessionKey = 'feishu:chat_1:mock-agent' as const;
    const proc = await manager.spawnAgent(
      sessionKey,
      'mock-agent',
      { workingDirectory: '/Users/test/current', permissionMode: 'blacklist' },
      handlers,
    ) as MockAgentProcess;

    proc.emitExit(1);

    expect(onProcessExit).toHaveBeenCalledTimes(1);
    expect(signalWasAborted).toBe(false);
    expect(contextWasCurrent).toBe(true);
  });

  it('aborts the old event context signal when a process is replaced', async () => {
    validatorMock.validateWorkingDirectory.mockResolvedValue(true);
    const handlers = handlersStub();
    const sessionKey = 'feishu:chat_1:mock-agent' as const;
    const original = await manager.spawnAgent(
      sessionKey,
      'mock-agent',
      { workingDirectory: '/Users/test/original', permissionMode: 'blacklist' },
      handlers,
    ) as MockAgentProcess;

    original.pushEvent({ type: 'text', content: 'old event' });
    await vi.waitFor(() => expect(handlers.onEvent).toHaveBeenCalledTimes(1));
    const eventContext = handlers.onEvent.mock.calls[0][2];

    expect(eventContext.signal.aborted).toBe(false);

    await manager.spawnAgent(
      sessionKey,
      'mock-agent',
      { workingDirectory: '/Users/test/replacement', permissionMode: 'blacklist' },
      handlers,
    );

    expect(eventContext.signal.aborted).toBe(true);
  });

  it('aborts the current context signal when cancellation is requested', async () => {
    validatorMock.validateWorkingDirectory.mockResolvedValue(true);
    const handlers = handlersStub();
    const sessionKey = 'feishu:chat_1:mock-agent' as const;
    const proc = await manager.spawnAgent(
      sessionKey,
      'mock-agent',
      { workingDirectory: '/Users/test/current', permissionMode: 'blacklist' },
      handlers,
    ) as MockAgentProcess;

    proc.pushEvent({ type: 'text', content: 'current event' });
    await vi.waitFor(() => expect(handlers.onEvent).toHaveBeenCalledTimes(1));
    const eventContext = handlers.onEvent.mock.calls[0][2];

    manager.cancelAgent(sessionKey);

    expect(eventContext.signal.aborted).toBe(true);
  });
});

function createMockPlugin(createProcess: () => MockAgentProcess): AgentPlugin {
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
    spawn: vi.fn().mockImplementation(createProcess),
    resume: vi.fn().mockImplementation(createProcess),
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

function createMockProcess(label: string): MockAgentProcess {
  const stdin = new Writable({ write(_, __, cb) { cb(); } });
  const stdout = new Readable({ objectMode: true, read() {} });
  const ee = new EventEmitter();
  return {
    label,
    pid: 12345,
    sessionId: '',
    stdin,
    stdout,
    kill: vi.fn(),
    on: (event: string, handler: any) => { ee.on(event, handler); },
    pushEvent: (event: unknown) => { stdout.push(event); },
    emitExit: (code: number | null) => ee.emit('exit', code),
  };
}

function handlersStub() {
  return {
    onEvent: vi.fn(),
    onToolBlocked: vi.fn(),
    onPermissionTimeout: vi.fn(),
    onProcessExit: vi.fn(),
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
