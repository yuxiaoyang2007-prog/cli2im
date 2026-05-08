import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable, Writable } from 'node:stream';
import type { AgentEvent, AgentPlugin, SpawnOpts } from '../src/types.js';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: spawnMock,
  };
});

import { GeminiPlugin, GeminiStreamParser, mapGeminiEvent } from '../src/agents/gemini.js';

function baseOpts(overrides: Partial<SpawnOpts> = {}): SpawnOpts {
  return {
    workingDirectory: '/Users/test/project',
    permissionMode: 'bypass',
    initialPrompt: 'hello gemini',
    ...overrides,
  };
}

function mockChildProcess() {
  const stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  return {
    pid: 4321,
    stdin,
    stdout,
    stderr,
    kill: vi.fn(),
    on: vi.fn(),
  };
}

describe('GeminiPlugin', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockReturnValue(mockChildProcess());
  });

  it('declares CLI-backed capabilities', () => {
    const plugin = new GeminiPlugin('/usr/local/bin/gemini');

    expect(plugin.capabilities).toEqual({
      streamJson: true,
      permissionPrompt: false,
      sessionResume: false,
      gracefulCancel: false,
      slashCommands: [],
    });
  });

  it('builds prompt args for stream-json yolo mode', () => {
    const plugin = new GeminiPlugin('/usr/local/bin/gemini');

    expect(plugin.buildSpawnArgs(baseOpts({ model: 'gemini-3.1-pro-preview' }))).toEqual([
      '--prompt',
      'hello gemini',
      '--output-format',
      'stream-json',
      '--approval-mode',
      'yolo',
      '--skip-trust',
      '--model',
      'gemini-3.1-pro-preview',
    ]);
  });

  it('builds resume args instead of prompt args', () => {
    const plugin = new GeminiPlugin('/usr/local/bin/gemini');

    expect(plugin.buildSpawnArgs(baseOpts(), 'ses_123')).toEqual([
      '--resume',
      'ses_123',
      '--output-format',
      'stream-json',
      '--approval-mode',
      'yolo',
      '--skip-trust',
    ]);
  });

  it('spawns gemini under script to provide a pseudo-TTY', () => {
    const plugin = new GeminiPlugin('/usr/local/bin/gemini');
    const opts = baseOpts({ env: { GEMINI_TEST: '1' } });

    const proc = plugin.spawn(opts);

    expect(proc.pid).toBe(4321);
    expect(spawnMock).toHaveBeenCalledWith(
      'script',
      [
        '-q',
        '/dev/null',
        '/usr/local/bin/gemini',
        '--prompt',
        'hello gemini',
        '--output-format',
        'stream-json',
        '--approval-mode',
        'yolo',
        '--skip-trust',
      ],
      expect.objectContaining({
        cwd: '/Users/test/project',
        env: expect.objectContaining({ GEMINI_TEST: '1' }),
      }),
    );
  });

  it('does not format stdin or cancel messages', () => {
    const plugin = new GeminiPlugin('/usr/local/bin/gemini');
    const agentPlugin = plugin as AgentPlugin;

    expect(plugin.formatStdinMessage({ role: 'user', content: 'hello' })).toBe('');
    expect(agentPlugin.formatCancelMessage).toBeUndefined();
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
