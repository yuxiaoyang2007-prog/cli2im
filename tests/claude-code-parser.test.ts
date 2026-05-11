import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import {
  ClaudeCodePlugin,
  ClaudeCodeVirtualProcess,
  createSDKEventMappingState,
  mapSDKEvent,
} from '../src/agents/claude-code.js';
import type { AgentEvent, SpawnOpts } from '../src/types.js';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

function baseOpts(): SpawnOpts {
  return {
    workingDirectory: '/Users/test/project',
    permissionMode: 'blacklist',
  };
}

function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error('Timed out waiting for condition'));
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

describe('ClaudeCodePlugin stdout parser', () => {
  const plugin = new ClaudeCodePlugin('/usr/local/bin/claude');

  it('passes AgentEvent objects through in object mode', async () => {
    const parser = plugin.createStdoutParser();
    const events: AgentEvent[] = [];
    parser.on('data', (event: AgentEvent) => events.push(event));

    parser.write({ type: 'text', content: 'Hello world' } satisfies AgentEvent);

    expect(events).toEqual([{ type: 'text', content: 'Hello world' }]);
  });
});

describe('mapSDKEvent', () => {
  it('maps stream text deltas and suppresses duplicate assistant text', () => {
    const state = createSDKEventMappingState();

    const deltaEvents = mapSDKEvent({
      type: 'stream_event',
      session_id: 'ses_1',
      parent_tool_use_id: null,
      uuid: '00000000-0000-4000-8000-000000000001',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hello' },
      },
    } as unknown as SDKMessage, state);

    const assistantEvents = mapSDKEvent({
      type: 'assistant',
      session_id: 'ses_1',
      parent_tool_use_id: null,
      uuid: '00000000-0000-4000-8000-000000000002',
      message: {
        id: 'msg_1',
        role: 'assistant',
        model: 'claude-sonnet-4-20250514',
        stop_reason: 'end_turn',
        stop_sequence: null,
        type: 'message',
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: 'text', text: 'Hello' }],
      },
    } as unknown as SDKMessage, state);

    expect(deltaEvents).toEqual([{ type: 'text', content: 'Hello' }]);
    expect(assistantEvents).toEqual([]);
  });

  it('maps assistant tool_use and tracks names for tool_result events', () => {
    const state = createSDKEventMappingState();

    const toolUseEvents = mapSDKEvent({
      type: 'assistant',
      session_id: 'ses_1',
      parent_tool_use_id: null,
      uuid: '00000000-0000-4000-8000-000000000003',
      message: {
        id: 'msg_2',
        role: 'assistant',
        model: 'claude-sonnet-4-20250514',
        stop_reason: 'tool_use',
        stop_sequence: null,
        type: 'message',
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } }],
      },
    } as unknown as SDKMessage, state);

    const toolResultEvents = mapSDKEvent({
      type: 'user',
      session_id: 'ses_1',
      parent_tool_use_id: null,
      uuid: '00000000-0000-4000-8000-000000000004',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok', is_error: false }],
      },
    } as unknown as SDKMessage, state);

    expect(toolUseEvents).toEqual([
      { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } },
    ]);
    expect(toolResultEvents).toEqual([
      { type: 'tool_result', id: 'tu_1', name: 'Bash', output: 'ok', isError: false },
    ]);
  });

  it('maps result and init status messages', () => {
    const state = createSDKEventMappingState();

    const statusEvents = mapSDKEvent({
      type: 'system',
      subtype: 'init',
      session_id: 'ses_init',
      uuid: '00000000-0000-4000-8000-000000000005',
    } as unknown as SDKMessage, state);

    const resultEvents = mapSDKEvent({
      type: 'result',
      subtype: 'success',
      session_id: 'ses_result',
      uuid: '00000000-0000-4000-8000-000000000006',
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 2,
      },
    } as unknown as SDKMessage, state);

    expect(statusEvents).toEqual([{ type: 'status', sessionId: 'ses_init' }]);
    expect(resultEvents).toEqual([
      {
        type: 'result',
        sessionId: 'ses_result',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 3,
          cacheWriteTokens: 2,
        },
      },
    ]);
    expect(state.latestSessionId).toBe('ses_result');
  });
});

describe('ClaudeCodeVirtualProcess permissions', () => {
  it('emits permission_request and resolves canUseTool from stdin response', async () => {
    const plugin = new ClaudeCodePlugin('/usr/local/bin/claude');
    const proc = plugin.spawn(baseOpts()) as ClaudeCodeVirtualProcess;
    const stdoutEvents: AgentEvent[] = [];
    proc.stdout.on('data', (event: AgentEvent) => stdoutEvents.push(event));

    const resultPromise = proc.canUseTool(
      'Bash',
      { command: 'ls' },
      { toolUseID: 'tu_perm', signal: new AbortController().signal },
    );

    await waitFor(() => stdoutEvents.length === 1);
    expect(stdoutEvents[0]).toEqual({
      type: 'permission_request',
      id: 'tu_perm',
      tool: 'Bash',
      input: { command: 'ls' },
    });

    proc.stdin.write(plugin.formatPermissionResponse('tu_perm', 'allow'));

    await expect(resultPromise).resolves.toEqual({ behavior: 'allow' });
  });
});

describe('ClaudeCodeVirtualProcess query lifecycle', () => {
  it('starts query on first user message, emits events, and stays alive after result', async () => {
    const queryFn = vi.fn(({ options }) => (async function* () {
      yield {
        type: 'assistant',
        session_id: 'ses_new',
        parent_tool_use_id: null,
        uuid: '00000000-0000-4000-8000-000000000007',
        message: {
          id: 'msg_3',
          role: 'assistant',
          model: 'claude-sonnet-4-20250514',
          stop_reason: 'end_turn',
          stop_sequence: null,
          type: 'message',
          usage: { input_tokens: 1, output_tokens: 1 },
          content: [{ type: 'text', text: 'Done' }],
        },
      } as unknown as SDKMessage;
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 'ses_new',
        uuid: '00000000-0000-4000-8000-000000000008',
        usage: { input_tokens: 1, output_tokens: 1 },
      } as unknown as SDKMessage;
      expect(options.resume).toBeUndefined();
    })());
    const plugin = new ClaudeCodePlugin('/usr/local/bin/claude', queryFn as any);
    const proc = plugin.spawn(baseOpts());
    const stdoutEvents: AgentEvent[] = [];
    const exitHandler = vi.fn();
    proc.stdout.on('data', (event: AgentEvent) => stdoutEvents.push(event));
    proc.on('exit', exitHandler);

    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'hello' }));

    await waitFor(() => stdoutEvents.some((event) => event.type === 'result'));

    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(stdoutEvents).toContainEqual({ type: 'text', content: 'Done' });
    expect(stdoutEvents).toContainEqual({
      type: 'result',
      sessionId: 'ses_new',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: undefined, cacheWriteTokens: undefined },
    });
    expect(proc.sessionId).toBe('ses_new');
    expect(exitHandler).not.toHaveBeenCalled();
  });

  it('attaches files only after successful Write tool results', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli2im-cc-write-'));
    try {
      const outPath = join(dir, 'out.py');
      const queryFn = vi.fn(() => (async function* () {
        yield assistantToolUse('tu_write', 'Write', { file_path: 'out.py' });
        writeFileSync(outPath, 'print("ok")\n');
        yield toolResult('tu_write', false);
        yield successResult('ses_write');
      })());
      const plugin = new ClaudeCodePlugin('/usr/local/bin/claude', queryFn as any);
      const proc = plugin.spawn({ ...baseOpts(), workingDirectory: dir });
      const stdoutEvents: AgentEvent[] = [];
      proc.stdout.on('data', (event: AgentEvent) => stdoutEvents.push(event));

      proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'write file' }));

      await waitFor(() => stdoutEvents.some((event) => event.type === 'result'));
      const result = stdoutEvents.find((event) => event.type === 'result');
      expect(result).toMatchObject({
        type: 'result',
        createdFiles: [expect.objectContaining({
          path: realpathSync(outPath),
          name: 'out.py',
        })],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not attach files from failed Write tool results', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli2im-cc-failed-write-'));
    try {
      writeFileSync(join(dir, 'out.md'), 'pre-existing');
      const queryFn = vi.fn(() => (async function* () {
        yield assistantToolUse('tu_write', 'Write', { file_path: 'out.md' });
        yield toolResult('tu_write', true);
        yield successResult('ses_failed_write');
      })());
      const plugin = new ClaudeCodePlugin('/usr/local/bin/claude', queryFn as any);
      const proc = plugin.spawn({ ...baseOpts(), workingDirectory: dir });
      const stdoutEvents: AgentEvent[] = [];
      proc.stdout.on('data', (event: AgentEvent) => stdoutEvents.push(event));

      proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'write file' }));

      await waitFor(() => stdoutEvents.some((event) => event.type === 'result'));
      const result = stdoutEvents.find((event) => event.type === 'result');
      expect(result).toMatchObject({ type: 'result', sessionId: 'ses_failed_write' });
      expect(result).not.toHaveProperty('createdFiles');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tracks Edit-created files as createdFiles', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli2im-cc-edit-'));
    try {
      const outPath = join(dir, 'created.ts');
      const queryFn = vi.fn(() => (async function* () {
        yield assistantToolUse('tu_edit', 'Edit', { file_path: 'created.ts' });
        writeFileSync(outPath, 'export const ok = true;\n');
        yield toolResult('tu_edit', false);
        yield successResult('ses_edit');
      })());
      const plugin = new ClaudeCodePlugin('/usr/local/bin/claude', queryFn as any);
      const proc = plugin.spawn({ ...baseOpts(), workingDirectory: dir });
      const stdoutEvents: AgentEvent[] = [];
      proc.stdout.on('data', (event: AgentEvent) => stdoutEvents.push(event));

      proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'edit file' }));

      await waitFor(() => stdoutEvents.some((event) => event.type === 'result'));
      const result = stdoutEvents.find((event) => event.type === 'result');
      expect(result).toMatchObject({
        type: 'result',
        createdFiles: [expect.objectContaining({
          path: realpathSync(outPath),
          name: 'created.ts',
        })],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function assistantToolUse(id: string, name: string, input: Record<string, unknown>): SDKMessage {
  return {
    type: 'assistant',
    session_id: 'ses_tool',
    parent_tool_use_id: null,
    uuid: `00000000-0000-4000-8000-${id.padStart(12, '0').slice(-12)}`,
    message: {
      id: `msg_${id}`,
      role: 'assistant',
      model: 'claude-sonnet-4-20250514',
      stop_reason: 'tool_use',
      stop_sequence: null,
      type: 'message',
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: 'tool_use', id, name, input }],
    },
  } as unknown as SDKMessage;
}

function toolResult(toolUseId: string, isError: boolean): SDKMessage {
  return {
    type: 'user',
    session_id: 'ses_tool',
    parent_tool_use_id: null,
    uuid: `00000000-0000-4000-8001-${toolUseId.padStart(12, '0').slice(-12)}`,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: isError ? 'failed' : 'ok', is_error: isError }],
    },
  } as unknown as SDKMessage;
}

function successResult(sessionId: string): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    session_id: sessionId,
    uuid: `00000000-0000-4000-8002-${sessionId.padStart(12, '0').slice(-12)}`,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as SDKMessage;
}

describe('ClaudeCodePlugin formatters', () => {
  const plugin = new ClaudeCodePlugin('/usr/local/bin/claude');

  it('formats user text messages', () => {
    const msg = plugin.formatStdinMessage({ role: 'user', content: 'hello' });
    const parsed = JSON.parse(msg);
    expect(parsed.type).toBe('user');
    expect(parsed.message.role).toBe('user');
    expect(parsed.message.content).toBe('hello');
  });

  it('formats permission responses', () => {
    const msg = plugin.formatPermissionResponse('tu_1', 'deny');
    const parsed = JSON.parse(msg);
    expect(parsed.type).toBe('tool_use_permission_response');
    expect(parsed.tool_use_id).toBe('tu_1');
    expect(parsed.decision).toBe('deny');
  });
});
