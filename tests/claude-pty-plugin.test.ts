import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { ClaudePtyVirtualProcess, type ClaudePtyRuntimeDeps } from '../src/agents/claude-pty.js';
import type { AgentEvent, UserMessage } from '../src/types.js';
import type { StopMarker } from '../src/agents/pty/SettingsInjector.js';

class FakeRunner {
  pid = 4242;
  currentState: 'starting' | 'ready' | 'busy' | 'exited' = 'ready';
  writes: string[] = [];
  writeTimes: number[] = [];
  spawn = vi.fn(async () => {});
  kill = vi.fn((_signal?: string) => {
    this.currentState = 'exited';
  });
  dataListenerDisposes = 0;
  exitListenerDisposes = 0;
  private events = new EventEmitter();

  write(data: string): void {
    this.writes.push(data);
    this.writeTimes.push(Date.now());
  }

  onData(cb: (chunk: string) => void): () => void {
    this.events.on('data', cb);
    return () => {
      this.dataListenerDisposes += 1;
      this.events.off('data', cb);
    };
  }

  onExit(cb: (event: { exitCode: number; signal?: number }) => void): () => void {
    this.events.on('exit', cb);
    return () => {
      this.exitListenerDisposes += 1;
      this.events.off('exit', cb);
    };
  }

  emitData(chunk: string): void {
    this.events.emit('data', chunk);
  }
}

class FakeTailer {
  drains = 0;
  seekToEnd = vi.fn(async () => {});
  onDrain?: () => void;
  private batches: Array<unknown[] | Promise<unknown[]>> = [];

  push(records: unknown[] | Promise<unknown[]>): void {
    this.batches.push(records);
  }

  async drain(): Promise<unknown[]> {
    this.drains += 1;
    this.onDrain?.();
    return await (this.batches.shift() ?? []);
  }
}

function userPayload(text: string): string {
  const message: UserMessage = { role: 'user', content: text };
  return `${JSON.stringify({ type: 'user', message })}\n`;
}

function collectEvents(proc: ClaudePtyVirtualProcess): AgentEvent[] {
  const events: AgentEvent[] = [];
  proc.stdout.on('data', (event) => events.push(event as AgentEvent));
  return events;
}

function makeDeps(options: {
  status?: Array<{ sessionId: string; transcriptPath: string }>;
  statusError?: Error;
  tailers?: FakeTailer[];
  runners?: FakeRunner[];
  stopCallbacks?: Array<(marker: StopMarker) => void>;
} = {}): ClaudePtyRuntimeDeps & { runners: FakeRunner[]; tailers: FakeTailer[]; stopCallbacks: Array<(marker: StopMarker) => void> } {
  const runners = options.runners ?? [];
  const tailers = options.tailers ?? [];
  const stopCallbacks = options.stopCallbacks ?? [];
  const status = [...(options.status ?? [{ sessionId: 'sess_1', transcriptPath: '/tmp/transcript-1.jsonl' }])];
  return {
    runners,
    tailers,
    stopCallbacks,
    createRunner: () => {
      const runner = runners.shift() ?? new FakeRunner();
      runners.push(runner);
      return runner;
    },
    createTailer: () => {
      const tailer = tailers.shift() ?? new FakeTailer();
      tailers.push(tailer);
      return tailer;
    },
    watchStop: (_file, _filter, cb) => {
      stopCallbacks.push(cb);
      return () => {};
    },
    waitForStatuslinePayload: async () => {
      if (options.statusError) throw options.statusError;
      const next = status.shift();
      if (!next) throw new Error('missing status fixture');
      return next;
    },
    buildSettings: async () => ({
      settingsPath: '/tmp/settings.json',
      rawPayloadFile: '/tmp/status.json',
      stopMarkerFile: '/tmp/stop.json',
    }),
  };
}

describe('ClaudePtyVirtualProcess', () => {
  it('queues a first stdin message while init is starting, then emits status and result with session id', async () => {
    const tailer = new FakeTailer();
    tailer.push([
      {
        type: 'assistant',
        session_id: 'sess_1',
        message: { content: [{ type: 'text', text: 'hello' }] },
      },
    ]);
    const deps = makeDeps({ tailers: [tailer] });
    const proc = new ClaudePtyVirtualProcess('claude', {
      workingDirectory: process.cwd(),
      permissionMode: 'bypass',
    }, undefined, deps);
    const events = collectEvents(proc);

    proc.stdin.write(userPayload('hi'));
    await vi.waitFor(() => expect(deps.stopCallbacks.length).toBe(1));
    deps.stopCallbacks[0]({
      hook_event_name: 'Stop',
      session_id: 'sess_1',
      transcript_path: '/tmp/transcript-1.jsonl',
      turnSeq: 1,
    });

    await vi.waitFor(() => expect(events.some((event) => event.type === 'result')).toBe(true));
    expect(events).toContainEqual({ type: 'status', sessionId: 'sess_1' });
    expect(events).toContainEqual({ type: 'text', content: 'hello' });
    expect(events).toContainEqual({
      type: 'result',
      sessionId: 'sess_1',
      usage: undefined,
    });
    expect(proc.sessionId).toBe('sess_1');
  });

  it('fails init once, reports pending turns, ends stdout, and emits exit', async () => {
    const deps = makeDeps({ statusError: new Error('statusline missing') });
    const proc = new ClaudePtyVirtualProcess('claude', {
      workingDirectory: process.cwd(),
      permissionMode: 'bypass',
    }, undefined, deps);
    const events = collectEvents(proc);
    const exit = vi.fn();
    proc.on('exit', exit);

    proc.stdin.write(userPayload('first'));

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(events).toEqual([{ type: 'error', message: 'statusline missing' }]);
    expect(proc.stdout.readableEnded).toBe(true);
  });

  it('cleans up the runner when statusline init fails after spawn', async () => {
    const runner = new FakeRunner();
    const deps = makeDeps({
      runners: [runner],
      statusError: new Error('statusline missing'),
    });
    const proc = new ClaudePtyVirtualProcess('claude', {
      workingDirectory: process.cwd(),
      permissionMode: 'bypass',
    }, undefined, deps);
    const exit = vi.fn();
    proc.on('exit', exit);

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(runner.spawn).toHaveBeenCalledTimes(1);
    expect(runner.kill).toHaveBeenCalledWith('SIGTERM');
    expect(runner.dataListenerDisposes).toBe(1);
    expect(runner.exitListenerDisposes).toBe(1);
  });

  it('can be killed before init finishes without emitting a stale status', async () => {
    let resolveStatus!: (value: { sessionId: string; transcriptPath: string }) => void;
    const deps = makeDeps();
    deps.waitForStatuslinePayload = () => new Promise((resolve) => {
      resolveStatus = resolve;
    });
    const proc = new ClaudePtyVirtualProcess('claude', {
      workingDirectory: process.cwd(),
      permissionMode: 'bypass',
    }, undefined, deps);
    const events = collectEvents(proc);
    const exit = vi.fn();
    proc.on('exit', exit);

    await vi.waitFor(() => expect(resolveStatus).toBeTypeOf('function'));
    proc.kill();
    resolveStatus({ sessionId: 'late_session', transcriptPath: '/tmp/late.jsonl' });

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(null));
    expect(events).toEqual([]);
    expect(proc.sessionId).toBe('');
  });

  it('accepts the bypass permissions init menu with separated keypresses once', async () => {
    const runner = new FakeRunner();
    const deps = makeDeps({ runners: [runner] });
    deps.waitForStatuslinePayload = async () => {
      await vi.waitFor(() => {
        expect(runner.writes).toEqual(['\x1b[B', '\r']);
      });
      return { sessionId: 'sess_1', transcriptPath: '/tmp/transcript-1.jsonl' };
    };
    const proc = new ClaudePtyVirtualProcess('claude', {
      workingDirectory: process.cwd(),
      permissionMode: 'bypass',
    }, undefined, deps);
    const events = collectEvents(proc);

    await vi.waitFor(() => expect(runner.spawn).toHaveBeenCalled());
    runner.emitData([
      'WARNING: Claude Code running in Bypass Permissions mode',
      '❯ 1. No, exit',
      '  2. Yes, I accept',
      'Enter to confirm · Esc to cancel',
    ].join('\n'));
    runner.emitData([
      'WARNING: Claude Code running in Bypass Permissions mode',
      '❯ 1. No, exit',
      '  2. Yes, I accept',
      'Enter to confirm · Esc to cancel',
    ].join('\n'));

    await vi.waitFor(() => expect(events).toContainEqual({ type: 'status', sessionId: 'sess_1' }));
    expect(runner.writes).toEqual(['\x1b[B', '\r']);
    expect(runner.writeTimes[1] - runner.writeTimes[0]).toBeGreaterThanOrEqual(250);
    proc.kill();
  });

  it('disposes a timed out runtime and rebuilds before the next message', async () => {
    const firstRunner = new FakeRunner();
    const secondRunner = new FakeRunner();
    const secondTailer = new FakeTailer();
    secondTailer.push([
      {
        type: 'assistant',
        session_id: 'sess_1',
        message: { content: [{ type: 'text', text: 'after rebuild' }] },
      },
    ]);
    const deps = makeDeps({
      status: [
        { sessionId: 'sess_1', transcriptPath: '/tmp/transcript-1.jsonl' },
        { sessionId: 'sess_1', transcriptPath: '/tmp/transcript-2.jsonl' },
      ],
      runners: [firstRunner, secondRunner],
      tailers: [new FakeTailer(), secondTailer],
    });
    const proc = new ClaudePtyVirtualProcess('claude', {
      workingDirectory: process.cwd(),
      permissionMode: 'bypass',
    }, 'sess_1', deps, { turnTimeoutMs: 10, pollIntervalMs: 2 });
    const events = collectEvents(proc);

    proc.stdin.write(userPayload('will timeout'));
    await vi.waitFor(() => expect(events.some((event) => event.type === 'error')).toBe(true));
    expect(firstRunner.kill).toHaveBeenCalled();

    proc.stdin.write(userPayload('next'));
    await vi.waitFor(() => expect(deps.stopCallbacks.length).toBe(2));
    deps.stopCallbacks[1]({
      hook_event_name: 'Stop',
      session_id: 'sess_1',
      transcript_path: '/tmp/transcript-2.jsonl',
      turnSeq: 1,
    });

    await vi.waitFor(() => expect(events.some((event) => event.type === 'text' && event.content === 'after rebuild')).toBe(true));
    expect(secondRunner.writes.join('')).toContain('next');
  });

  it('uses the outer deadline path even when elapsed fallback would fire first', async () => {
    let now = 0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const firstRunner = new FakeRunner();
      const secondRunner = new FakeRunner();
      const firstTailer = new FakeTailer();
      firstTailer.onDrain = () => {
        now = 25;
      };
      const secondTailer = new FakeTailer();
      secondTailer.push([
        {
          type: 'assistant',
          session_id: 'sess_1',
          message: { content: [{ type: 'text', text: 'after fallback deadline' }] },
        },
      ]);
      const deps = makeDeps({
        status: [
          { sessionId: 'sess_1', transcriptPath: '/tmp/transcript-1.jsonl' },
          { sessionId: 'sess_1', transcriptPath: '/tmp/transcript-2.jsonl' },
        ],
        runners: [firstRunner, secondRunner],
        tailers: [firstTailer, secondTailer],
      });
      const proc = new ClaudePtyVirtualProcess('claude', {
        workingDirectory: process.cwd(),
        permissionMode: 'bypass',
      }, 'sess_1', deps, { turnTimeoutMs: 20, pollIntervalMs: 1 });
      const events = collectEvents(proc);

      proc.stdin.write(userPayload('will timeout via elapsed fallback'));
      await vi.waitFor(() => expect(events.some((event) => event.type === 'error')).toBe(true));
      expect(firstRunner.kill).toHaveBeenCalledWith('SIGTERM');

      proc.stdin.write(userPayload('next'));
      await vi.waitFor(() => expect(deps.stopCallbacks.length).toBe(2));
      deps.stopCallbacks[1]({
        hook_event_name: 'Stop',
        session_id: 'sess_1',
        transcript_path: '/tmp/transcript-2.jsonl',
        turnSeq: 1,
      });

      await vi.waitFor(() => expect(events.some((event) => event.type === 'text' && event.content === 'after fallback deadline')).toBe(true));
      expect(secondRunner.writes.join('')).toContain('next');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('ignores a Stop decision that completes after the turn is cancelled', async () => {
    let resolveStopDrain!: (records: unknown[]) => void;
    const tailer = new FakeTailer();
    tailer.push([]);
    tailer.push(new Promise<unknown[]>((resolve) => {
      resolveStopDrain = resolve;
    }));
    const deps = makeDeps({ tailers: [tailer] });
    const proc = new ClaudePtyVirtualProcess('claude', {
      workingDirectory: process.cwd(),
      permissionMode: 'bypass',
    }, undefined, deps);
    const events = collectEvents(proc);

    await vi.waitFor(() => expect(events).toContainEqual({ type: 'status', sessionId: 'sess_1' }));
    deps.stopCallbacks[0]({
      hook_event_name: 'Stop',
      session_id: 'sess_1',
      transcript_path: '/tmp/transcript-1.jsonl',
      turnSeq: 1,
    });
    const cancel = { cancelled: false };
    (proc as unknown as { activeCancel: { cancelled: boolean } }).activeCancel = cancel;
    const waitForTurn = (proc as unknown as {
      waitForPtyTurn: () => Promise<{ branch: string; events: AgentEvent[]; reason?: string }>;
    }).waitForPtyTurn();

    await vi.waitFor(() => expect(tailer.drains).toBe(2));
    cancel.cancelled = true;
    resolveStopDrain([
      {
        type: 'assistant',
        session_id: 'sess_1',
        message: { content: [{ type: 'text', text: 'late stop result' }] },
      },
    ]);

    await expect(waitForTurn).resolves.toEqual({
      branch: 'ignored',
      events: [],
      reason: 'turn cancelled',
    });
    expect(events).not.toContainEqual({ type: 'text', content: 'late stop result' });
    proc.kill();
  });

  it('runs an anchored SDK slash command without sender or relay prefixes and seeks the tailer afterward', async () => {
    const runner = new FakeRunner();
    const tailer = new FakeTailer();
    const deps = makeDeps({ runners: [runner], tailers: [tailer] });
    const proc = new ClaudePtyVirtualProcess('claude', {
      workingDirectory: process.cwd(),
      permissionMode: 'bypass',
    }, undefined, deps, { slashQuietMs: 100, slashTimeoutMs: 500 });
    const events = collectEvents(proc);

    await vi.waitFor(() => expect(events).toContainEqual({ type: 'status', sessionId: 'sess_1' }));
    proc.stdin.write(userPayload([
      '<cti-sender channel="relay" user_id="relay:codexbot" bot="codexbot"/>',
      '',
      '<cti-relay>relay directive</cti-relay>',
      '',
      '/review',
    ].join('\n')));

    await vi.waitFor(() => expect(runner.writes).toContain('/review\r'));
    runner.emitData('Review output\n');

    await vi.waitFor(() => expect(events.some((event) => event.type === 'result' && event.noRelay)).toBe(true));
    expect(runner.writes).toContain('/review\r');
    expect(runner.writes.join('')).not.toContain('<cti-sender');
    expect(runner.writes.join('')).not.toContain('<cti-relay>');
    expect(events).toContainEqual({ type: 'text', content: 'Review output', noRelay: true });
    expect(events).toContainEqual({ type: 'result', sessionId: 'sess_1', noRelay: true });
    expect(tailer.seekToEnd).toHaveBeenCalledTimes(1);
    proc.kill();
  });
});
