import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { AgentEvent, AgentPlugin, SpawnOpts } from '../src/types.js';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: spawnMock,
  };
});

import { GeminiPlugin, GeminiStreamParser, GeminiVirtualProcess, mapGeminiEvent } from '../src/agents/gemini.js';

function baseOpts(overrides: Partial<SpawnOpts> = {}): SpawnOpts {
  return {
    workingDirectory: '/Users/test/project',
    permissionMode: 'bypass',
    initialPrompt: 'hello gemini',
    ...overrides,
  };
}

class MockChildProcess extends EventEmitter {
  pid: number;
  stdinChunks: string[] = [];
  stdin = new Writable({
    write: (chunk, _encoding, callback) => {
      this.stdinChunks.push(chunk.toString());
      callback();
    },
  });
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn();

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  close(code: number | null): void {
    this.stdout.end();
    this.stderr.end();
    this.emit('close', code);
  }
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('GeminiPlugin', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockReturnValue(new MockChildProcess(4321));
  });

  it('declares CLI-backed capabilities', () => {
    const plugin = new GeminiPlugin('/usr/local/bin/gemini');

    expect(plugin.capabilities).toEqual({
      streamJson: true,
      permissionPrompt: false,
      sessionResume: true,
      gracefulCancel: false,
      slashCommands: [],
    });
  });

  it('builds only base stream-json yolo args', () => {
    const plugin = new GeminiPlugin('/usr/local/bin/gemini');

    expect(plugin.buildSpawnArgs(baseOpts({ model: 'gemini-3.1-pro-preview' }))).toEqual([
      '--output-format',
      'stream-json',
      '--approval-mode',
      'yolo',
      '--skip-trust',
      '--model',
      'gemini-3.1-pro-preview',
    ]);
  });

  it('does not include resume or prompt args in base args', () => {
    const plugin = new GeminiPlugin('/usr/local/bin/gemini');

    expect(plugin.buildSpawnArgs(baseOpts())).toEqual([
      '--output-format',
      'stream-json',
      '--approval-mode',
      'yolo',
      '--skip-trust',
    ]);
  });

  it('returns a virtual process without spawning until the first message', () => {
    const plugin = new GeminiPlugin('/usr/local/bin/gemini');
    const opts = baseOpts({ env: { GEMINI_TEST: '1' } });

    const proc = plugin.spawn(opts);

    expect(proc).toBeInstanceOf(GeminiVirtualProcess);
    expect(proc.pid).toBe(process.pid);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('uses an object-mode pass-through parser and JSON-line stdin messages', () => {
    const plugin = new GeminiPlugin('/usr/local/bin/gemini');
    const agentPlugin = plugin as AgentPlugin;

    const parser = plugin.createStdoutParser();

    expect(parser).toBeInstanceOf(PassThrough);
    expect(plugin.formatStdinMessage({ role: 'user', content: 'hello' })).toBe(
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }) + '\n',
    );
    expect(agentPlugin.formatCancelMessage).toBeUndefined();
  });
});

describe('GeminiVirtualProcess', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it('spawns one Gemini child for the first stdin message using -p', () => {
    const child = new MockChildProcess(5001);
    spawnMock.mockReturnValue(child);
    const plugin = new GeminiPlugin('/usr/local/bin/gemini');
    const proc = plugin.spawn(baseOpts({ env: { GEMINI_TEST: '1' } }));

    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'first turn' }));

    expect(spawnMock).toHaveBeenCalledWith(
      '/usr/local/bin/gemini',
      [
        '--output-format',
        'stream-json',
        '--approval-mode',
        'yolo',
        '--skip-trust',
        '-p',
        'first turn',
      ],
      expect.objectContaining({
        cwd: '/Users/test/project',
        env: expect.objectContaining({ GEMINI_TEST: '1' }),
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  });

  it('captures sessionId from init status events', async () => {
    const child = new MockChildProcess(5001);
    spawnMock.mockReturnValue(child);
    const plugin = new GeminiPlugin('/usr/local/bin/gemini');
    const proc = plugin.spawn(baseOpts());
    const events: AgentEvent[] = [];
    proc.stdout.on('data', (event: AgentEvent) => events.push(event));

    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'first turn' }));
    child.stdout.write('{"type":"init","session_id":"ses_1"}\n');

    expect(proc.sessionId).toBe('ses_1');
    expect(events).toContainEqual({ type: 'status', sessionId: 'ses_1' });
  });

  it('runs queued messages after close and parser drain, resuming captured session', async () => {
    const child1 = new MockChildProcess(5001);
    const child2 = new MockChildProcess(5002);
    spawnMock.mockReturnValueOnce(child1).mockReturnValueOnce(child2);
    const plugin = new GeminiPlugin('/usr/local/bin/gemini');
    const proc = plugin.spawn(baseOpts());

    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'first turn' }));
    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'second turn' }));
    child1.stdout.write('{"type":"init","session_id":"ses_1"}\n');
    child1.close(0);
    await nextTick();

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[1][1]).toEqual([
      '--output-format',
      'stream-json',
      '--approval-mode',
      'yolo',
      '--skip-trust',
      '--resume',
      'ses_1',
      '-p',
      'second turn',
    ]);
  });

  it('kill terminates the active child, emits exit once, and does not drain queued messages', async () => {
    const child = new MockChildProcess(5001);
    spawnMock.mockReturnValue(child);
    const plugin = new GeminiPlugin('/usr/local/bin/gemini');
    const proc = plugin.spawn(baseOpts());
    const exits: Array<number | null> = [];
    proc.on('exit', (code) => exits.push(code));

    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'first turn' }));
    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'second turn' }));
    proc.kill('SIGTERM');
    child.close(null);
    await nextTick();

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(exits).toEqual([null]);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('emits stderr as an error on non-zero exit and clears the pending queue', async () => {
    const child1 = new MockChildProcess(5001);
    const child2 = new MockChildProcess(5002);
    spawnMock.mockReturnValueOnce(child1).mockReturnValueOnce(child2);
    const plugin = new GeminiPlugin('/usr/local/bin/gemini');
    const proc = plugin.spawn(baseOpts());
    const events: AgentEvent[] = [];
    proc.stdout.on('data', (event: AgentEvent) => events.push(event));

    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'first turn' }));
    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'queued stale turn' }));
    child1.stderr.write('API quota exhausted\n');
    child1.close(1);
    await nextTick();

    expect(events).toContainEqual({ type: 'error', message: 'API quota exhausted' });
    expect(spawnMock).toHaveBeenCalledTimes(1);

    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'fresh retry' }));

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[1][1]).toContain('fresh retry');
    expect(spawnMock.mock.calls[1][1]).not.toContain('queued stale turn');
  });

  it('falls back to stdin pipe when prompt exceeds 100KB', () => {
    const child = new MockChildProcess(5001);
    spawnMock.mockReturnValue(child);
    const plugin = new GeminiPlugin('/usr/local/bin/gemini');
    const proc = plugin.spawn(baseOpts());
    const longPrompt = 'x'.repeat(100 * 1024 + 1);

    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: longPrompt }));

    expect(spawnMock.mock.calls[0][1]).toEqual([
      '--output-format',
      'stream-json',
      '--approval-mode',
      'yolo',
      '--skip-trust',
    ]);
    expect(spawnMock.mock.calls[0][2]).toEqual(expect.objectContaining({
      stdio: ['pipe', 'pipe', 'pipe'],
    }));
    expect(child.stdinChunks.join('')).toBe(longPrompt);
  });
});

describe('mapGeminiEvent', () => {
  it('maps init, assistant deltas, tool events, and success result', () => {
    const events: AgentEvent[] = [];
    const state = { sessionId: '', toolNamesById: new Map<string, string>() };

    events.push(...mapGeminiEvent({ type: 'init', session_id: 'ses_1' }, state));
    events.push(...mapGeminiEvent({ type: 'message', role: 'assistant', content: 'partial text', delta: true }, state));
    events.push(...mapGeminiEvent({
      type: 'tool_use',
      tool_name: 'list_directory',
      tool_id: 'list_directory_123_0',
      parameters: { dir_path: '.' },
    }, state));
    events.push(...mapGeminiEvent({
      type: 'tool_result',
      tool_id: 'list_directory_123_0',
      status: 'success',
    }, state));
    events.push(...mapGeminiEvent({
      type: 'result',
      status: 'success',
      stats: {
        input_tokens: 10,
        output_tokens: 5,
        cached: 3,
      },
    }, state));

    expect(events).toEqual([
      { type: 'status', sessionId: 'ses_1' },
      { type: 'text', content: 'partial text' },
      {
        type: 'tool_use',
        id: 'list_directory_123_0',
        name: 'list_directory',
        input: { dir_path: '.' },
      },
      {
        type: 'tool_result',
        id: 'list_directory_123_0',
        name: 'list_directory',
        output: 'success',
      },
      {
        type: 'result',
        sessionId: 'ses_1',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 3,
        },
      },
    ]);
  });

  it('maps non-success result to error', () => {
    const state = { sessionId: 'ses_1', toolNamesById: new Map<string, string>() };

    expect(mapGeminiEvent({ type: 'result', status: 'cancelled' }, state)).toEqual([
      { type: 'error', message: 'cancelled' },
    ]);
  });
});

describe('GeminiStreamParser', () => {
  it('parses newline-delimited JSON and skips non-JSON lines', () => {
    const parser = new GeminiStreamParser();
    const events: AgentEvent[] = [];
    parser.on('data', (event: AgentEvent) => events.push(event));

    parser.write('YOLO mode enabled\n');
    parser.write('{"type":"init","session_id":"ses_1"}\n{"type":"message","role":"assistant","content":"hi","delta":true}\n');

    expect(events).toEqual([
      { type: 'status', sessionId: 'ses_1' },
      { type: 'text', content: 'hi' },
    ]);
  });

  it('keeps partial lines buffered until newline arrives', () => {
    const parser = new GeminiStreamParser();
    const events: AgentEvent[] = [];
    parser.on('data', (event: AgentEvent) => events.push(event));

    parser.write('{"type":"message","role":"assistant"');
    expect(events).toEqual([]);

    parser.write(',"content":"hello","delta":true}\n');
    expect(events).toEqual([{ type: 'text', content: 'hello' }]);
  });
});
