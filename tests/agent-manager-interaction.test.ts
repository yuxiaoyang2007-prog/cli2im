import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter, Readable, Transform, Writable } from 'node:stream';
import { AgentManager, type AgentManagerEvents } from '../src/agents/manager.js';
import { ToolGate } from '../src/agents/tool-gate.js';
import type { AgentEvent, AgentPlugin, AgentProcess, SpawnOpts } from '../src/types.js';

vi.mock('content-guard', () => ({ detectInjection: vi.fn(() => ({ detected: false, score: 0, severity: 'none' })) }));

function createProcess(written: string[]): AgentProcess {
  const ee = new EventEmitter();
  return {
    pid: 1,
    sessionId: '',
    stdin: new Writable({ write(chunk, _, cb) { written.push(String(chunk)); cb(); } }),
    stdout: new Readable({ objectMode: true, read() {} }),
    kill: vi.fn(),
    on: (event: string, handler: any) => { ee.on(event, handler); },
  };
}

function createPlugin(proc: AgentProcess): AgentPlugin {
  return {
    name: 'mock-agent',
    displayName: 'Mock',
    capabilities: { streamJson: true, permissionPrompt: true, sessionResume: true, gracefulCancel: false, slashCommands: [] },
    preflight: vi.fn(),
    spawn: vi.fn(() => proc),
    resume: vi.fn(() => proc),
    buildSpawnArgs: vi.fn(() => []),
    createStdoutParser: () => new Transform({ objectMode: true, transform(chunk, _, cb) { cb(null, chunk); } }),
    formatStdinMessage: (msg) => JSON.stringify(msg) + '\n',
    formatPermissionResponse: (id, decision) => JSON.stringify({ perm: id, decision }) + '\n',
    formatQuestionResponse: (id, answers) => JSON.stringify({ question: id, answers }) + '\n',
  };
}

function handlers(overrides: Partial<AgentManagerEvents> = {}): AgentManagerEvents {
  return { onEvent: vi.fn(), onToolBlocked: vi.fn(), onPermissionTimeout: vi.fn(), onProcessExit: vi.fn(), ...overrides };
}

const key = 'feishu:chat_1:ccbot' as const;
const opts: SpawnOpts = { workingDirectory: '/Users/test/project', permissionMode: 'blacklist' };
const questions = [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }];

async function setup(spawnOpts: SpawnOpts, events: Partial<AgentManagerEvents>) {
  const written: string[] = [];
  const proc = createProcess(written);
  const manager = new AgentManager(new ToolGate(['sudo\\s+']), () => {});
  manager.registerPlugin(createPlugin(proc));
  await manager.spawnAgent(key, 'mock-agent', spawnOpts, handlers(events));
  return { manager, proc, written };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

afterEach(() => { vi.useRealTimers(); });

describe('AgentManager questions', () => {
  it('forwards a question and writes the chat answer back once', async () => {
    const onQuestion = vi.fn();
    const { manager, proc, written } = await setup(opts, { onQuestion });
    proc.stdout.push({ type: 'question_request', id: 'q1', questions } satisfies AgentEvent);
    await tick();
    expect(onQuestion).toHaveBeenCalledWith(key, 'q1', questions);
    expect(manager.hasPendingQuestion(key, 'q1')).toBe(true);

    expect(manager.answerQuestion(key, 'q1', { 'Which?': 'B' })).toBe(true);
    expect(written).toContain(JSON.stringify({ question: 'q1', answers: { 'Which?': 'B' } }) + '\n');
    expect(manager.hasPendingQuestion(key, 'q1')).toBe(false);
    expect(manager.answerQuestion(key, 'q1', {})).toBe(false);
  });

  it('answers immediately as unanswered when no chat handler exists', async () => {
    const { proc, written } = await setup(opts, {});
    proc.stdout.push({ type: 'question_request', id: 'q2', questions } satisfies AgentEvent);
    await tick();
    expect(written).toContain(JSON.stringify({ question: 'q2', answers: {} }) + '\n');
  });

  it('times out an unanswered question after 30 minutes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const onQuestionTimeout = vi.fn();
    const { manager, proc, written } = await setup(opts, { onQuestion: vi.fn(), onQuestionTimeout });
    proc.stdout.push({ type: 'question_request', id: 'q3', questions } satisfies AgentEvent);
    await tick();
    vi.advanceTimersByTime(30 * 60_000);
    await tick();
    expect(written).toContain(JSON.stringify({ question: 'q3', answers: {} }) + '\n');
    expect(onQuestionTimeout).toHaveBeenCalledWith(key, 'q3');
    expect(manager.hasPendingQuestion(key, 'q3')).toBe(false);
  });

  it('drops pending questions when the process is cancelled', async () => {
    const { manager, proc } = await setup(opts, { onQuestion: vi.fn() });
    proc.stdout.push({ type: 'question_request', id: 'q4', questions } satisfies AgentEvent);
    await tick();
    manager.cancelAgent(key);
    expect(manager.hasPendingQuestion(key, 'q4')).toBe(false);
    expect(manager.answerQuestion(key, 'q4', { 'Which?': 'A' })).toBe(false);
  });
});

describe('AgentManager auto mode approvals', () => {
  it('asks the chat for any request auto mode forwards, even with autoApprove', async () => {
    const onToolBlocked = vi.fn();
    const { proc, written } = await setup({ ...opts, permissionMode: 'auto', autoApprove: true }, { onToolBlocked });
    proc.stdout.push({ type: 'permission_request', id: 'p1', tool: 'Bash', input: { command: 'git push origin main' } } satisfies AgentEvent);
    await tick();
    expect(onToolBlocked).toHaveBeenCalledWith(key, 'git push origin main', 'p1');
    expect(written.some((line) => line.includes('"perm":"p1"'))).toBe(false);
  });

  it('keeps auto-approving outside auto mode', async () => {
    const onToolBlocked = vi.fn();
    const { proc, written } = await setup({ ...opts, autoApprove: true }, { onToolBlocked });
    proc.stdout.push({ type: 'permission_request', id: 'p2', tool: 'Bash', input: { command: 'sudo ls' } } satisfies AgentEvent);
    await tick();
    expect(onToolBlocked).not.toHaveBeenCalled();
    expect(written).toContain(JSON.stringify({ perm: 'p2', decision: 'allow' }) + '\n');
  });
});
