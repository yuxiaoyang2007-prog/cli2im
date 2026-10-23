import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodePlugin, ClaudeCodeVirtualProcess, parseAskUserQuestions } from '../src/agents/claude-code.js';
import type { AgentEvent, SpawnOpts } from '../src/types.js';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

function baseOpts(overrides: Partial<SpawnOpts> = {}): SpawnOpts {
  return { workingDirectory: '/Users/test/project', permissionMode: 'blacklist', ...overrides };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

function gatedQuery(messages: SDKMessage[]) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const queryFn = vi.fn(() => (async function* () {
    for (const message of messages) yield message;
    await gate;
  })());
  return { queryFn, release };
}

const askInput = {
  questions: [{
    question: 'Which color?',
    header: 'Color',
    multiSelect: false,
    options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cool' }],
  }],
};

afterEach(() => { vi.useRealTimers(); });

describe('ClaudeCodeVirtualProcess AskUserQuestion', () => {
  it('parses AskUserQuestion input and rejects malformed shapes', () => {
    expect(parseAskUserQuestions(askInput)).toEqual([{
      question: 'Which color?', header: 'Color', multiSelect: false,
      options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cool' }],
    }]);
    expect(parseAskUserQuestions({ questions: [] })).toBeUndefined();
    expect(parseAskUserQuestions({ questions: [{ question: 'x', options: [] }] })).toBeUndefined();
  });

  it('asks the chat even when tools are auto-approved, and returns the answers', async () => {
    const plugin = new ClaudeCodePlugin('/usr/local/bin/claude');
    const proc = plugin.spawn(baseOpts({ autoApprove: true })) as ClaudeCodeVirtualProcess;
    const events: AgentEvent[] = [];
    proc.stdout.on('data', (event: AgentEvent) => events.push(event));
    await flush();
    try {
      const result = proc.canUseTool('AskUserQuestion', askInput, { toolUseID: 'tu_ask', signal: new AbortController().signal });
      await flush();
      expect(events).toContainEqual({ type: 'question_request', id: 'tu_ask', questions: parseAskUserQuestions(askInput) });
      proc.stdin.write(plugin.formatQuestionResponse('tu_ask', { 'Which color?': 'Blue' }));
      await expect(result).resolves.toEqual({
        behavior: 'allow',
        updatedInput: { ...askInput, answers: { 'Which color?': 'Blue' } },
      });
    } finally { proc.kill(); }
  });

  it('keeps the original input when the user did not answer', async () => {
    const plugin = new ClaudeCodePlugin('/usr/local/bin/claude');
    const proc = plugin.spawn(baseOpts({ autoApprove: true })) as ClaudeCodeVirtualProcess;
    proc.stdout.resume();
    try {
      const result = proc.canUseTool('AskUserQuestion', askInput, { toolUseID: 'tu_skip', signal: new AbortController().signal });
      proc.stdin.write(plugin.formatQuestionResponse('tu_skip', {}));
      await expect(result).resolves.toEqual({ behavior: 'allow', updatedInput: askInput });
    } finally { proc.kill(); }
  });

  it('denies a pending question when the process is terminated', async () => {
    const plugin = new ClaudeCodePlugin('/usr/local/bin/claude');
    const proc = plugin.spawn(baseOpts({ autoApprove: true })) as ClaudeCodeVirtualProcess;
    proc.stdout.resume();
    const result = proc.canUseTool('AskUserQuestion', askInput, { toolUseID: 'tu_kill', signal: new AbortController().signal });
    proc.kill();
    await expect(result).resolves.toMatchObject({ behavior: 'deny' });
  });
});

describe('ClaudeCodeVirtualProcess auto mode', () => {
  it.each([
    ['auto', true],
    ['default', false],
  ] as const)('with effective mode %s forwards approval to the chat: %s', async (effective, forwards) => {
    const { queryFn, release } = gatedQuery([
      { type: 'system', subtype: 'init', session_id: 'ses_auto', permissionMode: effective } as unknown as SDKMessage,
    ]);
    const plugin = new ClaudeCodePlugin('/usr/local/bin/claude', queryFn as any);
    const proc = plugin.spawn(baseOpts({ permissionMode: 'auto', autoApprove: true })) as ClaudeCodeVirtualProcess;
    const events: AgentEvent[] = [];
    proc.stdout.on('data', (event: AgentEvent) => events.push(event));
    try {
      proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'hi' }));
      await flush();
      expect((queryFn.mock.calls[0] as unknown as [{ options: { permissionMode: string } }])[0].options.permissionMode).toBe('auto');
      const result = proc.canUseTool('Bash', { command: 'git push' }, { toolUseID: 'tu_auto', signal: new AbortController().signal });
      await flush();
      expect(events.some((event) => event.type === 'permission_request')).toBe(forwards);
      if (forwards) proc.stdin.write(plugin.formatPermissionResponse('tu_auto', 'deny'));
      await expect(result).resolves.toMatchObject({ behavior: forwards ? 'deny' : 'allow' });
    } finally { release(); proc.kill(); }
  });
});

describe('ClaudeCodeVirtualProcess keep-alive', () => {
  it('heartbeats while a background task runs and stops after it finishes', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queryFn = vi.fn(() => (async function* () {
      yield { type: 'system', subtype: 'task_started', task_id: 'bg1', session_id: 's' } as unknown as SDKMessage;
      await finished;
      yield { type: 'system', subtype: 'task_notification', task_id: 'bg1', status: 'completed', session_id: 's' } as unknown as SDKMessage;
      await gate;
    })());
    const plugin = new ClaudeCodePlugin('/usr/local/bin/claude', queryFn as any);
    const proc = plugin.spawn(baseOpts());
    const heartbeats: AgentEvent[] = [];
    proc.stdout.on('data', (event: AgentEvent) => { if (event.type === 'status' && !event.sessionId) heartbeats.push(event); });
    try {
      proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'run in background' }));
      await flush();
      expect(heartbeats).toHaveLength(0);
      vi.advanceTimersByTime(61_000);
      expect(heartbeats).toHaveLength(1);
      vi.advanceTimersByTime(60_000);
      expect(heartbeats).toHaveLength(2);

      finish();
      await flush();
      const afterFinish = heartbeats.length;
      vi.advanceTimersByTime(180_000);
      expect(heartbeats).toHaveLength(afterFinish);
    } finally { release(); proc.kill(); }
  });
});
