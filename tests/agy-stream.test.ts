import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../src/types.js';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: mocks.spawn,
}));

import { AgyPlugin, AgyStreamParser, agyModelSupportsEffortFlag } from '../src/agents/agy.js';

class MockChild extends EventEmitter {
  pid = 4242;
  chunks: string[] = [];
  stdinEnded = false;
  stdin = new Writable({
    write: (chunk, _encoding, done) => {
      this.chunks.push(String(chunk));
      done();
    },
    final: (done) => {
      this.stdinEnded = true;
      done();
    },
  });
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn(() => {
    this.emit('close', null);
    return true;
  });
}

describe('AgyStreamParser & persistent multi-turn stream-json', () => {
  afterEach(() => {
    mocks.spawn.mockReset();
  });

  it('parses init, tool_use/tool_result, thinking, text_delta, result usage, and error events', async () => {
    const parser = new AgyStreamParser();
    const events: AgentEvent[] = [];
    parser.on('data', (ev: AgentEvent) => events.push(ev));

    parser.write(
      JSON.stringify({ event: 'init', conversation_id: 'conv-123' }) + '\n'
      + JSON.stringify({
        event: 'step_update',
        step_update: {
          conversation_id: 'conv-123',
          step_index: 1,
          state: 'ACTIVE',
          step_type: 'thinking',
          text_delta: 'pondering...',
        },
      }) + '\n'
      + JSON.stringify({
        event: 'step_update',
        step_update: {
          conversation_id: 'conv-123',
          step_index: 2,
          state: 'ACTIVE',
          step_type: 'tool',
          tool_name: 'read_file',
          tool_info: { name: 'read_file', parameters: { Path: '/tmp/a.txt' } },
        },
      }) + '\n'
      + JSON.stringify({
        event: 'step_update',
        step_update: {
          conversation_id: 'conv-123',
          step_index: 2,
          state: 'DONE',
          step_type: 'tool',
          tool_name: 'read_file',
          tool_info: { name: 'read_file', parameters: { Path: '/tmp/a.txt' }, output: 'ok' },
        },
      }) + '\n'
      + JSON.stringify({
        event: 'step_update',
        step_update: {
          conversation_id: 'conv-123',
          step_index: 3,
          state: 'DONE',
          step_type: 'tool',
          tool_name: 'grep_search',
          tool_info: { name: 'grep_search', error: 'no access' },
        },
      }) + '\n'
      + JSON.stringify({
        event: 'step_update',
        step_update: {
          conversation_id: 'conv-123',
          step_index: 4,
          state: 'ACTIVE',
          step_type: 'agent_response',
          text_delta: 'Hello ',
        },
      }) + '\n'
      + JSON.stringify({
        event: 'step_update',
        step_update: {
          conversation_id: 'conv-123',
          step_index: 4,
          state: 'DONE',
          step_type: 'agent_response',
          text_delta: 'world',
        },
      }) + '\n'
      + JSON.stringify({
        event: 'result',
        result: {
          conversation_id: 'conv-123',
          status: 'SUCCESS',
          response: 'Hello world',
          usage: { input_tokens: 100, output_tokens: 12, cache_read_tokens: 40 },
        },
      }) + '\n',
    );

    // Turn 2 with fallback response (no text_delta)
    parser.write(
      JSON.stringify({
        event: 'result',
        result: {
          conversation_id: 'conv-123',
          status: 'SUCCESS',
          response: 'Command handled',
          usage: { input_tokens: 10, output_tokens: 2, cache_read_tokens: 0 },
        },
      }) + '\n',
    );

    // Turn 3 error
    parser.write(
      JSON.stringify({
        event: 'result',
        result: {
          conversation_id: 'conv-123',
          status: 'ERROR',
          error: 'rate limited',
        },
      }) + '\n',
    );
    parser.end();

    expect(events).toEqual([
      { type: 'status', sessionId: 'conv-123' },
      { type: 'thinking', content: 'pondering...' },
      { type: 'tool_use', id: 'agy_step_2', name: 'read_file', input: { Path: '/tmp/a.txt' } },
      { type: 'tool_result', id: 'agy_step_2', name: 'read_file', output: 'ok', isError: false },
      { type: 'tool_use', id: 'agy_step_3', name: 'grep_search', input: {} },
      { type: 'tool_result', id: 'agy_step_3', name: 'grep_search', output: 'no access', isError: true },
      { type: 'text', content: 'Hello ' },
      { type: 'text', content: 'world' },
      {
        type: 'result',
        sessionId: 'conv-123',
        usage: { inputTokens: 100, outputTokens: 12, cacheReadTokens: 40 },
      },
      { type: 'text', content: 'Command handled' },
      {
        type: 'result',
        sessionId: 'conv-123',
        usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0 },
      },
      { type: 'error', message: 'rate limited' },
    ]);
  });

  it('reuses a single persistent child process across multiple turns and keeps stdin open', () => {
    const child = new MockChild();
    mocks.spawn.mockReturnValue(child);
    const plugin = new AgyPlugin('/test/agy');
    expect(plugin.capabilities.streamJson).toBe(true);
    expect(plugin.capabilities.sessionResume).toBe(true);

    const proc = plugin.spawn({ workingDirectory: '/project', permissionMode: 'bypass' });
    const received: AgentEvent[] = [];
    proc.stdout.on('data', (ev: AgentEvent) => received.push(ev));

    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'turn 1' }));
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(child.stdinEnded).toBe(false);

    child.stdout.write(
      JSON.stringify({ event: 'init', conversation_id: 'conv-persist-1' }) + '\n'
      + JSON.stringify({
        event: 'step_update',
        step_update: { conversation_id: 'conv-persist-1', step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'A1' },
      }) + '\n'
      + JSON.stringify({ event: 'result', result: { conversation_id: 'conv-persist-1', status: 'SUCCESS', response: 'A1' } }) + '\n',
    );

    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'turn 2' }));
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(child.chunks.map((c) => JSON.parse(c.trim()))).toEqual([
      { event: 'user', message: { role: 'user', content: 'turn 1' } },
      { event: 'user', message: { role: 'user', content: 'turn 2' } },
    ]);

    child.stdout.write(
      JSON.stringify({ event: 'result', result: { conversation_id: 'conv-persist-1', status: 'SUCCESS', response: 'A2' } }) + '\n',
    );

    expect(proc.sessionId).toBe('conv-persist-1');
    expect(received.filter((e) => e.type === 'result')).toHaveLength(2);
    proc.kill();
  });

  it('respawns with --conversation when the persistent child exits unexpectedly after turn 1', () => {
    const child1 = new MockChild();
    const child2 = new MockChild();
    mocks.spawn.mockReturnValueOnce(child1).mockReturnValueOnce(child2);

    const plugin = new AgyPlugin('/test/agy');
    const proc = plugin.spawn({ workingDirectory: '/project', permissionMode: 'bypass' });
    const received: AgentEvent[] = [];
    proc.stdout.on('data', (ev: AgentEvent) => received.push(ev));

    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'hello' }));
    child1.stdout.write(
      JSON.stringify({ event: 'init', conversation_id: 'conv-respawn-9' }) + '\n'
      + JSON.stringify({ event: 'result', result: { conversation_id: 'conv-respawn-9', status: 'SUCCESS', response: 'hi' } }) + '\n',
    );

    // Unexpected crash while idle
    child1.emit('close', 0);

    // Next turn respawns with --conversation conv-respawn-9
    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'next turn' }));
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    const args2 = mocks.spawn.mock.calls[1][1] as string[];
    const convIdx = args2.indexOf('--conversation');
    expect(convIdx).toBeGreaterThanOrEqual(0);
    expect(args2[convIdx + 1]).toBe('conv-respawn-9');

    proc.kill();
  });

  it('only emits --effort for bare model names that support --effort', () => {
    expect(agyModelSupportsEffortFlag(undefined)).toBe(false);
    expect(agyModelSupportsEffortFlag('Orchestrator (Carbon)')).toBe(false);
    expect(agyModelSupportsEffortFlag('gemini-pro-orchestrator')).toBe(false);
    expect(agyModelSupportsEffortFlag('gemini-3.8-flash-low')).toBe(false);
    expect(agyModelSupportsEffortFlag('gemini-4-carbon-high')).toBe(false);
    expect(agyModelSupportsEffortFlag('gemini-4-carbon')).toBe(true);
    expect(agyModelSupportsEffortFlag('gemini-3.8-flash')).toBe(true);
    expect(agyModelSupportsEffortFlag('claude-opus-5-5')).toBe(true);

    const plugin = new AgyPlugin('/test/agy');
    const argsNoEffort = plugin.buildSpawnArgs({
      workingDirectory: '/project',
      permissionMode: 'bypass',
      model: 'gemini-3.8-flash-low',
      reasoningEffort: 'low',
    });
    expect(argsNoEffort).not.toContain('--effort');

    const argsWithEffort = plugin.buildSpawnArgs({
      workingDirectory: '/project',
      permissionMode: 'bypass',
      model: 'gemini-4-carbon',
      reasoningEffort: 'low',
    });
    expect(argsWithEffort[argsWithEffort.indexOf('--effort') + 1]).toBe('low');
  });

  it('passes --sandbox when sandbox or restrictive sandboxMode is configured', () => {
    const plugin = new AgyPlugin('/test/agy');
    expect(plugin.buildSpawnArgs({
      workingDirectory: '/project',
      permissionMode: 'bypass',
      sandbox: 'workdir',
    })).toContain('--sandbox');
    expect(plugin.buildSpawnArgs({
      workingDirectory: '/project',
      permissionMode: 'bypass',
      sandboxMode: 'workspace-write',
    })).toContain('--sandbox');
    expect(plugin.buildSpawnArgs({
      workingDirectory: '/project',
      permissionMode: 'bypass',
      sandboxMode: 'danger-full-access',
    })).not.toContain('--sandbox');
  });
});
