import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { ClaudePtyVirtualProcess, type ClaudePtyRuntimeDeps } from '../src/agents/claude-pty.js';
import type { AgentEvent, UserMessage } from '../src/types.js';
import type { StopMarker } from '../src/agents/pty/SettingsInjector.js';

class FakeRunner {
  pid = 4242;
  currentState: 'starting' | 'ready' | 'busy' | 'exited' = 'ready';
  writes: string[] = [];
  spawn = vi.fn(async () => {});
  kill = vi.fn(() => {});
  private events = new EventEmitter();

  write(data: string): void {
    this.writes.push(data);
  }

  onData(cb: (chunk: string) => void): () => void {
    this.events.on('data', cb);
    return () => this.events.off('data', cb);
  }

  onExit(cb: (event: { exitCode: number; signal?: number }) => void): () => void {
    this.events.on('exit', cb);
    return () => this.events.off('exit', cb);
  }
}

class FakeTailer {
  drains = 0;
  seekToEnd = vi.fn(async () => {});
  private batches: unknown[][] = [];

  push(records: unknown[]): void {
    this.batches.push(records);
  }

  async drain(): Promise<unknown[]> {
    this.drains += 1;
    return this.batches.shift() ?? [];
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
});
