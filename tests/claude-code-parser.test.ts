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

describe('ClaudeCodePlugin runtime instructions (appendSystemPrompt)', () => {
  it('appends to the claude_code preset rather than replacing the system prompt', async () => {
    let captured: any;
    const queryFn = vi.fn(({ options }) => (async function* () {
      captured = options;
      yield successResult('ses_append');
    })());
    const plugin = new ClaudeCodePlugin('/usr/local/bin/claude', queryFn as any);
    const proc = plugin.spawn({ ...baseOpts(), appendSystemPrompt: 'Always answer in French.' });
    const stdoutEvents: AgentEvent[] = [];
    proc.stdout.on('data', (event: AgentEvent) => stdoutEvents.push(event));

    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'hi' }));
    await waitFor(() => stdoutEvents.some((event) => event.type === 'result'));

    expect(captured.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: 'Always answer in French.',
    });
  });

  it('leaves systemPrompt untouched when no runtime instructions are set', async () => {
    let captured: any;
    const queryFn = vi.fn(({ options }) => (async function* () {
      captured = options;
      yield successResult('ses_plain');
    })());
    const plugin = new ClaudeCodePlugin('/usr/local/bin/claude', queryFn as any);
    const proc = plugin.spawn(baseOpts());
    const stdoutEvents: AgentEvent[] = [];
    proc.stdout.on('data', (event: AgentEvent) => stdoutEvents.push(event));

    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'hi' }));
    await waitFor(() => stdoutEvents.some((event) => event.type === 'result'));

    expect(captured.systemPrompt).toBeUndefined();
  });

  it('maps appendSystemPrompt to --append-system-prompt in buildSpawnArgs', () => {
    const plugin = new ClaudeCodePlugin('/usr/local/bin/claude');
    const args = plugin.buildSpawnArgs({ ...baseOpts(), appendSystemPrompt: 'Be concise.' });

    const flagIndex = args.indexOf('--append-system-prompt');
    expect(flagIndex).toBeGreaterThanOrEqual(0);
    expect(args[flagIndex + 1]).toBe('Be concise.');
  });
});

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

  it('removes abort listeners after repeated permission approvals on the same signal', async () => {
    const plugin = new ClaudeCodePlugin('/usr/local/bin/claude');
    const proc = plugin.spawn(baseOpts()) as ClaudeCodeVirtualProcess;
    const controller = new AbortController();
    const signal = controller.signal;
    const abortListeners = new Set<EventListenerOrEventListenerObject>();
    const originalAdd = signal.addEventListener.bind(signal);
    const originalRemove = signal.removeEventListener.bind(signal);
    const addSpy = vi.spyOn(signal, 'addEventListener').mockImplementation((type, listener, options) => {
      if (type === 'abort' && listener) abortListeners.add(listener);
      return originalAdd(type, listener, options);
    });
    const removeSpy = vi.spyOn(signal, 'removeEventListener').mockImplementation((type, listener, options) => {
      if (type === 'abort' && listener) abortListeners.delete(listener);
      return originalRemove(type, listener, options);
    });

    const first = proc.canUseTool(
      'Bash',
      { command: 'first' },
      { toolUseID: 'perm_1', signal },
    );
    proc.stdin.write(plugin.formatPermissionResponse('perm_1', 'allow'));
    await expect(first).resolves.toEqual({ behavior: 'allow' });

    const second = proc.canUseTool(
      'Bash',
      { command: 'second' },
      { toolUseID: 'perm_2', signal },
    );
    proc.stdin.write(plugin.formatPermissionResponse('perm_2', 'allow'));
    await expect(second).resolves.toEqual({ behavior: 'allow' });

    expect(addSpy).toHaveBeenCalledTimes(2);
    expect(removeSpy).toHaveBeenCalledTimes(2);
    expect(abortListeners.size).toBe(0);

    controller.abort();
    expect(abortListeners.size).toBe(0);
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

  it('streams multiple stdin messages through one lazy async prompt query', async () => {
    const consumed: unknown[] = [];
    const resumes: Array<string | undefined> = [];
    const queryFn = vi.fn(({ prompt, options }) => (async function* () {
      expect(isAsyncIterable(prompt)).toBe(true);
      resumes.push(options.resume);

      for await (const message of prompt as AsyncIterable<unknown>) {
        consumed.push(message);
        yield successResult(`ses_turn_${consumed.length}`);
        if (consumed.length === 3) break;
      }
    })());
    const plugin = new ClaudeCodePlugin('/usr/local/bin/claude', queryFn as any);
    const proc = plugin.spawn(baseOpts());
    const stdoutEvents: AgentEvent[] = [];
    proc.stdout.on('data', (event: AgentEvent) => stdoutEvents.push(event));

    expect(queryFn).not.toHaveBeenCalled();

    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'one' }));
    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'two' }));
    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'three' }));

    await waitFor(() => consumed.length === 3);

    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(resumes).toEqual([undefined]);
    expect(consumed).toEqual([
      {
        type: 'user',
        message: { role: 'user', content: 'one' },
        parent_tool_use_id: null,
      },
      {
        type: 'user',
        message: { role: 'user', content: 'two' },
        parent_tool_use_id: null,
      },
      {
        type: 'user',
        message: { role: 'user', content: 'three' },
        parent_tool_use_id: null,
      },
    ]);
    expect(stdoutEvents.filter((event) => event.type === 'result').map((event) => event.sessionId))
      .toEqual(['ses_turn_1', 'ses_turn_2', 'ses_turn_3']);
    expect(proc.sessionId).toBe('ses_turn_3');
  });

  it('emits exit after transport exit following result without dropping emitted output', async () => {
    const consumed: unknown[] = [];
    const resumes: Array<string | undefined> = [];
    const queryFn = vi.fn(({ prompt, options }) => (async function* () {
      resumes.push(options.resume);
      const iterator = (prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
      const message = await iterator.next();
      if (!message.done) consumed.push(message.value);

      yield successResult('ses_after_first');
      throw new Error('process exited with code 1');
    })());
    const plugin = new ClaudeCodePlugin('/usr/local/bin/claude', queryFn as any);
    const proc = plugin.spawn(baseOpts());
    const stdoutEvents: AgentEvent[] = [];
    const exitHandler = vi.fn();
    const errorHandler = vi.fn();
    proc.stdout.on('data', (event: AgentEvent) => stdoutEvents.push(event));
    proc.on('exit', exitHandler);
    proc.on('error', errorHandler);

    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'first' }));
    await waitFor(() => exitHandler.mock.calls.length === 1);

    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(resumes).toEqual([undefined]);
    expect(consumed).toEqual([
      {
        type: 'user',
        message: { role: 'user', content: 'first' },
        parent_tool_use_id: null,
      },
    ]);
    expect(stdoutEvents).toEqual([
      {
        type: 'result',
        sessionId: 'ses_after_first',
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
      },
    ]);
    expect(proc.sessionId).toBe('ses_after_first');
    expect(errorHandler).not.toHaveBeenCalled();
    expect(exitHandler).toHaveBeenCalledWith(1);
  });

  it('emits exit instead of replaying stdin queued after result before transport exit', async () => {
    let releaseTransportExit!: () => void;
    const consumed: unknown[] = [];
    const resumes: Array<string | undefined> = [];
    const queryFn = vi.fn(({ prompt, options }) => (async function* () {
      resumes.push(options.resume);
      const iterator = (prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
      const message = await iterator.next();
      if (!message.done) consumed.push(message.value);

      yield successResult('ses_after_first');
      await new Promise<void>((resolve) => {
        releaseTransportExit = resolve;
      });
      throw new Error('process exited with code 1');
    })());
    const plugin = new ClaudeCodePlugin('/usr/local/bin/claude', queryFn as any);
    const proc = plugin.spawn(baseOpts());
    const stdoutEvents: AgentEvent[] = [];
    const exitHandler = vi.fn();
    const errorHandler = vi.fn();
    proc.stdout.on('data', (event: AgentEvent) => stdoutEvents.push(event));
    proc.on('exit', exitHandler);
    proc.on('error', errorHandler);

    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'first' }));
    await waitFor(() => stdoutEvents.some((event) => event.type === 'result'));
    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'second' }));

    releaseTransportExit();
    await waitFor(() => exitHandler.mock.calls.length === 1);

    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(resumes).toEqual([undefined]);
    expect(consumed).toEqual([
      {
        type: 'user',
        message: { role: 'user', content: 'first' },
        parent_tool_use_id: null,
      },
    ]);
    expect(stdoutEvents).toEqual([
      {
        type: 'result',
        sessionId: 'ses_after_first',
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
      },
    ]);
    expect(proc.sessionId).toBe('ses_after_first');
    expect(errorHandler).not.toHaveBeenCalled();
    expect(exitHandler).toHaveBeenCalledWith(1);
  });

  it('does not replay stdin prefetched before a transport exit after result', async () => {
    let releaseTransportExit!: () => void;
    const consumed: unknown[] = [];
    const queryFn = vi.fn(({ prompt }) => (async function* () {
      const iterator = (prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
      const first = await iterator.next();
      if (!first.done) consumed.push(first.value);
      const second = await iterator.next();
      if (!second.done) consumed.push(second.value);

      yield successResult('ses_after_first');
      await new Promise<void>((resolve) => {
        releaseTransportExit = resolve;
      });
      throw new Error('process exited with code 1');
    })());
    const plugin = new ClaudeCodePlugin('/usr/local/bin/claude', queryFn as any);
    const proc = plugin.spawn(baseOpts());
    const stdoutEvents: AgentEvent[] = [];
    const exitHandler = vi.fn();
    const errorHandler = vi.fn();
    proc.stdout.on('data', (event: AgentEvent) => stdoutEvents.push(event));
    proc.on('exit', exitHandler);
    proc.on('error', errorHandler);

    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'first' }));
    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'second' }));
    await waitFor(() => stdoutEvents.some((event) => event.type === 'result'));

    releaseTransportExit();
    await waitFor(() => exitHandler.mock.calls.length === 1);

    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(consumed).toEqual([
      {
        type: 'user',
        message: { role: 'user', content: 'first' },
        parent_tool_use_id: null,
      },
      {
        type: 'user',
        message: { role: 'user', content: 'second' },
        parent_tool_use_id: null,
      },
    ]);
    expect(stdoutEvents).toEqual([
      {
        type: 'result',
        sessionId: 'ses_after_first',
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
      },
    ]);
    expect(proc.sessionId).toBe('ses_after_first');
    expect(errorHandler).not.toHaveBeenCalled();
    expect(exitHandler).toHaveBeenCalledWith(1);
  });

  it('emits exit after clean transport exit instead of idling for the next stdin message', async () => {
    let releaseTransportExit!: () => void;
    const consumed: unknown[] = [];
    const resumes: Array<string | undefined> = [];
    const queryFn = vi.fn(({ prompt, options }) => (async function* () {
      resumes.push(options.resume);
      const iterator = (prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
      const message = await iterator.next();
      if (!message.done) consumed.push(message.value);

      yield successResult('ses_after_first');
      await new Promise<void>((resolve) => {
        releaseTransportExit = resolve;
      });
      throw new Error('process exited with code 1');
    })());
    const plugin = new ClaudeCodePlugin('/usr/local/bin/claude', queryFn as any);
    const proc = plugin.spawn(baseOpts());
    const stdoutEvents: AgentEvent[] = [];
    const exitHandler = vi.fn();
    const errorHandler = vi.fn();
    proc.stdout.on('data', (event: AgentEvent) => stdoutEvents.push(event));
    proc.on('exit', exitHandler);
    proc.on('error', errorHandler);

    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'first' }));
    await waitFor(() => stdoutEvents.some((event) => event.type === 'result'));

    releaseTransportExit();
    await waitFor(() => exitHandler.mock.calls.length === 1);

    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(resumes).toEqual([undefined]);
    expect(consumed).toEqual([
      {
        type: 'user',
        message: { role: 'user', content: 'first' },
        parent_tool_use_id: null,
      },
    ]);
    expect(proc.sessionId).toBe('ses_after_first');
    expect(errorHandler).not.toHaveBeenCalled();
    expect(exitHandler).toHaveBeenCalledWith(1);
  });

  it('treats transport exit after next-turn side effects as fatal', async () => {
    const consumed: unknown[] = [];
    const queryFn = vi.fn(({ prompt }) => (async function* () {
      const iterator = (prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
      const first = await iterator.next();
      if (!first.done) consumed.push(first.value);
      yield successResult('ses_after_first');

      const second = await iterator.next();
      if (!second.done) consumed.push(second.value);
      yield assistantText('second visible output');
      throw new Error('process exited with code 1');
    })());
    const plugin = new ClaudeCodePlugin('/usr/local/bin/claude', queryFn as any);
    const proc = plugin.spawn(baseOpts());
    const stdoutEvents: AgentEvent[] = [];
    const errorHandler = vi.fn();
    const exitHandler = vi.fn();
    proc.stdout.on('data', (event: AgentEvent) => stdoutEvents.push(event));
    proc.on('error', errorHandler);
    proc.on('exit', exitHandler);

    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'first' }));
    await waitFor(() => stdoutEvents.some((event) => event.type === 'result'));
    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'second' }));

    try {
      await waitFor(() => exitHandler.mock.calls.length > 0);
    } finally {
      proc.kill();
    }

    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(consumed).toEqual([
      {
        type: 'user',
        message: { role: 'user', content: 'first' },
        parent_tool_use_id: null,
      },
      {
        type: 'user',
        message: { role: 'user', content: 'second' },
        parent_tool_use_id: null,
      },
    ]);
    expect(stdoutEvents).toContainEqual({ type: 'text', content: 'second visible output' });
    expect(stdoutEvents).toContainEqual({
      type: 'error',
      message: 'process exited with code 1',
    });
    expect(errorHandler).toHaveBeenCalledWith(expect.objectContaining({
      message: 'process exited with code 1',
    }));
    expect(exitHandler).toHaveBeenCalledWith(1);
  });

  it('does not carry streamed text or tool names across result boundaries', async () => {
    const queryFn = vi.fn(({ prompt }) => (async function* () {
      expect(isAsyncIterable(prompt)).toBe(true);

      yield {
        type: 'stream_event',
        session_id: 'ses_1',
        parent_tool_use_id: null,
        uuid: '00000000-0000-4000-8000-000000000020',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'streamed' },
        },
      } as unknown as SDKMessage;
      yield {
        type: 'assistant',
        session_id: 'ses_1',
        parent_tool_use_id: null,
        uuid: '00000000-0000-4000-8000-000000000021',
        message: {
          id: 'msg_streamed',
          role: 'assistant',
          model: 'claude-sonnet-4-20250514',
          stop_reason: 'end_turn',
          stop_sequence: null,
          type: 'message',
          usage: { input_tokens: 1, output_tokens: 1 },
          content: [{ type: 'text', text: 'duplicate' }],
        },
      } as unknown as SDKMessage;
      yield assistantToolUse('same_id', 'Bash', { command: 'ls' });
      yield toolResult('same_id', false);
      yield successResult('ses_1');

      yield {
        type: 'assistant',
        session_id: 'ses_2',
        parent_tool_use_id: null,
        uuid: '00000000-0000-4000-8000-000000000022',
        message: {
          id: 'msg_after_result',
          role: 'assistant',
          model: 'claude-sonnet-4-20250514',
          stop_reason: 'end_turn',
          stop_sequence: null,
          type: 'message',
          usage: { input_tokens: 1, output_tokens: 1 },
          content: [{ type: 'text', text: 'fresh turn text' }],
        },
      } as unknown as SDKMessage;
      yield toolResult('same_id', false);
      yield successResult('ses_2');
    })());
    const plugin = new ClaudeCodePlugin('/usr/local/bin/claude', queryFn as any);
    const proc = plugin.spawn(baseOpts());
    const stdoutEvents: AgentEvent[] = [];
    proc.stdout.on('data', (event: AgentEvent) => stdoutEvents.push(event));

    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'start' }));

    await waitFor(() => stdoutEvents.filter((event) => event.type === 'result').length === 2);

    expect(stdoutEvents).toContainEqual({ type: 'text', content: 'streamed' });
    expect(stdoutEvents).not.toContainEqual({ type: 'text', content: 'duplicate' });
    expect(stdoutEvents).toContainEqual({ type: 'text', content: 'fresh turn text' });
    expect(stdoutEvents.filter((event) => event.type === 'tool_result')).toEqual([
      { type: 'tool_result', id: 'same_id', name: 'Bash', output: 'ok', isError: false },
      { type: 'tool_result', id: 'same_id', name: '', output: 'ok', isError: false },
    ]);
  });

  it('buffers cold resume status until resume is accepted by a result', async () => {
    let releaseResult!: () => void;
    const queryFn = vi.fn(() => (async function* () {
      yield systemInit('ses_resume');
      await new Promise<void>((resolve) => {
        releaseResult = resolve;
      });
      yield successResult('ses_resume');
    })());
    const plugin = new ClaudeCodePlugin('/usr/local/bin/claude', queryFn as any);
    const proc = plugin.resume('ses_resume', baseOpts());
    const stdoutEvents: AgentEvent[] = [];
    proc.stdout.on('data', (event: AgentEvent) => stdoutEvents.push(event));

    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'continue' }));

    await waitFor(() => queryFn.mock.calls.length === 1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(stdoutEvents).toEqual([]);

    releaseResult();
    await waitFor(() => stdoutEvents.some((event) => event.type === 'result'));

    expect(stdoutEvents).toEqual([
      { type: 'status', sessionId: 'ses_resume' },
      {
        type: 'result',
        sessionId: 'ses_resume',
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
      },
    ]);
  });

  it('falls back to a fresh query and replays buffered input when cold resume fails before side effects', async () => {
    const consumed: unknown[] = [];
    const resumes: Array<string | undefined> = [];
    const queryFn = vi.fn(({ prompt, options }) => (async function* () {
      resumes.push(options.resume);

      if (options.resume === 'poisoned_session') {
        yield systemInit('poisoned_session');
        throw new Error('API Error: 400 thinking blocks cannot be modified');
      }

      for await (const message of prompt as AsyncIterable<unknown>) {
        consumed.push(message);
        yield systemInit('fresh_session');
        yield successResult('fresh_session');
        break;
      }
    })());
    const plugin = new ClaudeCodePlugin('/usr/local/bin/claude', queryFn as any);
    const proc = plugin.resume('poisoned_session', baseOpts());
    const stdoutEvents: AgentEvent[] = [];
    const exitHandler = vi.fn();
    proc.stdout.on('data', (event: AgentEvent) => stdoutEvents.push(event));
    proc.on('exit', exitHandler);

    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'recover me' }));

    await waitFor(() => stdoutEvents.some((event) => event.type === 'result'));

    expect(queryFn).toHaveBeenCalledTimes(2);
    expect(resumes).toEqual(['poisoned_session', undefined]);
    expect(consumed).toEqual([
      {
        type: 'user',
        message: { role: 'user', content: 'recover me' },
        parent_tool_use_id: null,
      },
    ]);
    expect(stdoutEvents).toEqual([
      { type: 'status', sessionId: 'fresh_session' },
      {
        type: 'result',
        sessionId: 'fresh_session',
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
      },
    ]);
    expect(proc.sessionId).toBe('fresh_session');
    expect(exitHandler).not.toHaveBeenCalled();
  });

  it('falls back when cold resume returns synthetic thinking-400 text and success without throwing', async () => {
    const consumed: unknown[] = [];
    const resumes: Array<string | undefined> = [];
    const queryFn = vi.fn(({ prompt, options }) => (async function* () {
      resumes.push(options.resume);

      if (options.resume === 'poisoned_session') {
        yield assistantText(
          'API Error: 400 messages.3.content.10: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified.',
          '<synthetic>',
        );
        yield systemInit('poisoned_session');
        yield successResult('poisoned_session');
        await new Promise<void>((_resolve, reject) => {
          options.abortController.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
        return;
      }

      for await (const message of prompt as AsyncIterable<unknown>) {
        consumed.push(message);
        yield systemInit('fresh_session');
        yield successResult('fresh_session');
        break;
      }
    })());
    const plugin = new ClaudeCodePlugin('/usr/local/bin/claude', queryFn as any);
    const proc = plugin.resume('poisoned_session', baseOpts());
    const stdoutEvents: AgentEvent[] = [];
    const exitHandler = vi.fn();
    proc.stdout.on('data', (event: AgentEvent) => stdoutEvents.push(event));
    proc.on('exit', exitHandler);

    try {
      proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'recover me' }));

      await waitFor(() => queryFn.mock.calls.length === 2);
      await waitFor(() => stdoutEvents.some((event) => event.type === 'result'));

      expect(resumes).toEqual(['poisoned_session', undefined]);
      expect(consumed).toEqual([
        {
          type: 'user',
          message: { role: 'user', content: 'recover me' },
          parent_tool_use_id: null,
        },
      ]);
      expect(stdoutEvents).toEqual([
        { type: 'status', sessionId: 'fresh_session' },
        {
          type: 'result',
          sessionId: 'fresh_session',
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: undefined,
            cacheWriteTokens: undefined,
          },
        },
      ]);
      expect(stdoutEvents).not.toContainEqual(expect.objectContaining({
        type: 'text',
        content: expect.stringContaining('cannot be modified'),
      }));
      expect(proc.sessionId).toBe('fresh_session');
      expect(exitHandler).not.toHaveBeenCalled();
    } finally {
      proc.kill();
    }
  });

  it('does not fallback when non-synthetic resumed assistant text looks like thinking-400', async () => {
    const resumes: Array<string | undefined> = [];
    const spoofText = 'API Error: 400 messages.3.content.10: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified.';
    const queryFn = vi.fn(({ options }) => (async function* () {
      resumes.push(options.resume);
      yield assistantText(spoofText, 'claude-opus-4-8');
      yield successResult('ses_resume');
    })());
    const plugin = new ClaudeCodePlugin('/usr/local/bin/claude', queryFn as any);
    const proc = plugin.resume('ses_resume', baseOpts());
    const stdoutEvents: AgentEvent[] = [];
    const exitHandler = vi.fn();
    proc.stdout.on('data', (event: AgentEvent) => stdoutEvents.push(event));
    proc.on('exit', exitHandler);

    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'repeat the error' }));

    await waitFor(() => stdoutEvents.some((event) => event.type === 'result'));

    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(resumes).toEqual(['ses_resume']);
    expect(stdoutEvents).toEqual([
      { type: 'text', content: spoofText },
      {
        type: 'result',
        sessionId: 'ses_resume',
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
      },
    ]);
    expect(proc.sessionId).toBe('ses_resume');
    expect(exitHandler).not.toHaveBeenCalled();
  });

  it('does not fallback when resumed assistant text only explains thinking block mutation errors', async () => {
    const resumes: Array<string | undefined> = [];
    const queryFn = vi.fn(({ options }) => (async function* () {
      resumes.push(options.resume);
      yield assistantText(
        'Claude thinking blocks cannot be modified because they must remain as they were in the prior response.',
      );
      yield successResult('ses_resume');
    })());
    const plugin = new ClaudeCodePlugin('/usr/local/bin/claude', queryFn as any);
    const proc = plugin.resume('ses_resume', baseOpts());
    const stdoutEvents: AgentEvent[] = [];
    const exitHandler = vi.fn();
    proc.stdout.on('data', (event: AgentEvent) => stdoutEvents.push(event));
    proc.on('exit', exitHandler);

    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'explain that error' }));

    await waitFor(() => stdoutEvents.some((event) => event.type === 'result'));

    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(resumes).toEqual(['ses_resume']);
    expect(stdoutEvents).toEqual([
      {
        type: 'text',
        content: 'Claude thinking blocks cannot be modified because they must remain as they were in the prior response.',
      },
      {
        type: 'result',
        sessionId: 'ses_resume',
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
      },
    ]);
    expect(proc.sessionId).toBe('ses_resume');
    expect(exitHandler).not.toHaveBeenCalled();
  });

  it('does not fallback after resume produced user-visible output', async () => {
    const queryFn = vi.fn(() => (async function* () {
      yield assistantText('already started');
      throw new Error('resume failed late');
    })());
    const plugin = new ClaudeCodePlugin('/usr/local/bin/claude', queryFn as any);
    const proc = plugin.resume('ses_resume', baseOpts());
    const stdoutEvents: AgentEvent[] = [];
    const exitHandler = vi.fn();
    proc.stdout.on('data', (event: AgentEvent) => stdoutEvents.push(event));
    proc.on('exit', exitHandler);

    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'continue' }));

    await waitFor(() => exitHandler.mock.calls.length === 1);

    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(stdoutEvents).toEqual([
      { type: 'text', content: 'already started' },
      { type: 'error', message: 'resume failed late' },
    ]);
    expect(exitHandler).toHaveBeenCalledWith(1);
  });

  it('does not fallback after canUseTool emitted a permission request', async () => {
    const queryFn = vi.fn(({ options }) => (async function* () {
      void options.canUseTool?.(
        'Bash',
        { command: 'rm -rf tmp' },
        { toolUseID: 'perm_side_effect', signal: new AbortController().signal },
      );
      throw new Error('resume failed after permission');
    })());
    const plugin = new ClaudeCodePlugin('/usr/local/bin/claude', queryFn as any);
    const proc = plugin.resume('ses_resume', baseOpts());
    const stdoutEvents: AgentEvent[] = [];
    const exitHandler = vi.fn();
    proc.stdout.on('data', (event: AgentEvent) => stdoutEvents.push(event));
    proc.on('exit', exitHandler);

    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'needs tool' }));

    await waitFor(() => exitHandler.mock.calls.length === 1);

    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(stdoutEvents).toEqual([
      {
        type: 'permission_request',
        id: 'perm_side_effect',
        tool: 'Bash',
        input: { command: 'rm -rf tmp' },
      },
      { type: 'error', message: 'resume failed after permission' },
    ]);
    expect(exitHandler).toHaveBeenCalledWith(1);
  });

  it('does not fallback after auto-approved canUseTool during cold resume', async () => {
    const consumed: unknown[] = [];
    const resumes: Array<string | undefined> = [];
    const queryFn = vi.fn(({ prompt, options }) => (async function* () {
      resumes.push(options.resume);

      if (options.resume === 'ses_resume') {
        await options.canUseTool?.(
          'Bash',
          { command: 'touch already-approved' },
          { toolUseID: 'auto_perm_side_effect', signal: new AbortController().signal },
        );
        throw new Error('resume failed after auto-approved permission');
      }

      for await (const message of prompt as AsyncIterable<unknown>) {
        consumed.push(message);
        yield systemInit('fresh_session');
        yield successResult('fresh_session');
        break;
      }
    })());
    const plugin = new ClaudeCodePlugin('/usr/local/bin/claude', queryFn as any);
    const proc = plugin.resume('ses_resume', {
      ...baseOpts(),
      autoApprove: true,
    });
    const stdoutEvents: AgentEvent[] = [];
    const exitHandler = vi.fn();
    proc.stdout.on('data', (event: AgentEvent) => stdoutEvents.push(event));
    proc.on('exit', exitHandler);

    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'needs tool' }));

    await waitFor(
      () => exitHandler.mock.calls.length === 1 || queryFn.mock.calls.length === 2 || stdoutEvents.length > 0,
    );

    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(resumes).toEqual(['ses_resume']);
    expect(consumed).toEqual([]);
    expect(stdoutEvents).toEqual([
      { type: 'error', message: 'resume failed after auto-approved permission' },
    ]);
    expect(exitHandler).toHaveBeenCalledWith(1);
  });

  it('does not fallback when cancelled during cold resume', async () => {
    const queryFn = vi.fn(({ options }) => (async function* () {
      await new Promise<void>((_resolve, reject) => {
        options.abortController.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    })());
    const plugin = new ClaudeCodePlugin('/usr/local/bin/claude', queryFn as any);
    const proc = plugin.resume('ses_resume', baseOpts());
    const exitHandler = vi.fn();
    proc.on('exit', exitHandler);

    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'continue' }));
    await waitFor(() => queryFn.mock.calls.length === 1);
    proc.stdin.write(plugin.formatCancelMessage());

    await waitFor(() => exitHandler.mock.calls.length === 1);

    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(exitHandler).toHaveBeenCalledWith(null);
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

function assistantText(text: string, model = 'claude-sonnet-4-20250514'): SDKMessage {
  return {
    type: 'assistant',
    session_id: 'ses_text',
    parent_tool_use_id: null,
    uuid: `00000000-0000-4000-8003-${text.length.toString().padStart(12, '0')}`,
    message: {
      id: `msg_${text.length}`,
      role: 'assistant',
      model,
      stop_reason: 'end_turn',
      stop_sequence: null,
      type: 'message',
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: 'text', text }],
    },
  } as unknown as SDKMessage;
}

function systemInit(sessionId: string): SDKMessage {
  return {
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    uuid: `00000000-0000-4000-8004-${sessionId.padStart(12, '0').slice(-12)}`,
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

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return !!value && typeof value === 'object' && Symbol.asyncIterator in value;
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
