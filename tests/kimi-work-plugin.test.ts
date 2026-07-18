import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KimiWorkPlugin, type KimiWorkPluginDeps } from '../src/agents/kimi-work.js';
import type {
  KimiWorkRpcHandlers,
  KimiWorkRpcNotification,
  SpawnedKimiDaimon,
} from '../src/agents/kimi-work-protocol.js';
import { KimiWorkRpcError } from '../src/agents/kimi-work-protocol.js';
import type { AgentEvent, AgentProcess, SpawnOpts } from '../src/types.js';

class FakeChild extends EventEmitter {
  pid = 4242;
  stderr = new PassThrough();
  kill = vi.fn(() => true);
}

class FakeRpc {
  handlers: KimiWorkRpcHandlers = {};
  connect = vi.fn().mockResolvedValue(undefined);
  dispose = vi.fn();
  sendRequest = vi.fn(async <R = unknown>(method: string, params?: any): Promise<R> => {
    let result: unknown;
    if (method === 'conversations.create') {
      const conversationKey = `desktop-local-chat:conversation:${this.createCount++}`;
      result = {
        agentId: 'main',
        session: { activeConversationKey: conversationKey },
        conversation: {},
      };
    } else if (method === 'conversations.send') {
      const error = this.sendErrors.shift();
      if (error) throw error;
      result = { accepted: true, turnId: `turn-${this.sendCount++}`, conversationKey: params.conversationKey };
    } else if (method === 'conversations.getMessages') {
      result = { messages: this.messages };
    } else {
      result = {};
    }
    return result as R;
  });
  private createCount = 1;
  private sendCount = 1;
  sendErrors: Error[] = [];
  messages: Array<{
    id: string;
    role: string;
    status: string;
    turnId?: string;
    parts: Array<{ kind: string; text?: string }>;
  }> = [];

  emitNotification(method: string, params: unknown): void {
    this.handlers.onNotification?.({ jsonrpc: '2.0', method, params } as KimiWorkRpcNotification);
  }
}

const opts: SpawnOpts = {
  workingDirectory: '/tmp',
  permissionMode: 'blacklist',
  reasoningEffort: 'high',
};

describe('KimiWorkPlugin', () => {
  let child: FakeChild;
  let rpc: FakeRpc;
  let startDaimon: ReturnType<typeof vi.fn>;
  let plugin: KimiWorkPlugin;
  let rpcQueue: FakeRpc[];

  beforeEach(() => {
    child = new FakeChild();
    rpc = new FakeRpc();
    rpcQueue = [rpc];
    startDaimon = vi.fn().mockResolvedValue({
      child: child as unknown as ChildProcess,
      url: 'ws://127.0.0.1:1234/control',
      token: 'token',
      nodePath: '/Applications/Kimi.app/Contents/Resources/resources/runtime/node',
      shareDir: '/tmp/kimi-share',
      configPath: '/tmp/kimi-share/config.json',
    } satisfies SpawnedKimiDaimon);
    const deps: KimiWorkPluginDeps = {
      startDaimon,
      createRpcClient: (_url, _token, handlers) => {
        const nextRpc = rpcQueue.shift() ?? rpc;
        nextRpc.handlers = handlers;
        return nextRpc as unknown as ReturnType<KimiWorkPluginDeps['createRpcClient']>;
      },
    };
    plugin = new KimiWorkPlugin({
      binary: '/Applications/Kimi.app/Contents/Resources/resources/daimon-bundle/bin/kimi-daimon',
      defaultModel: 'k3-agent',
      defaultEffort: 'high',
    }, deps);
  });

  it('exposes the complete non-resumable AgentPlugin contract', () => {
    expect(plugin.name).toBe('kimi-work');
    expect(plugin.capabilities).toEqual({
      streamJson: true,
      permissionPrompt: true,
      sessionResume: false,
      gracefulCancel: true,
      slashCommands: [],
    });
    expect(plugin.buildSpawnArgs(opts)).toEqual([
      '--node',
      '/Applications/Kimi.app/Contents/Resources/resources/runtime/node',
      'start',
      '--control',
    ]);
    expect(plugin.formatStdinMessage({ role: 'user', content: 'hello' })).toBe(
      '{"type":"user","message":{"role":"user","content":"hello"}}\n',
    );
    expect(plugin.formatPermissionResponse('ci_1', 'deny')).toBe(
      '{"type":"permission_response","requestId":"ci_1","decision":"deny"}\n',
    );
    expect(plugin.formatCancelMessage()).toBe('{"type":"cancel"}\n');
  });

  it('single-flights shared daimon startup and routes events by conversationKey', async () => {
    const first = plugin.spawn(opts);
    const second = plugin.spawn(opts);
    const firstEvents = collectEvents(first);
    const secondEvents = collectEvents(second);

    first.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'first' }));
    second.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'second' }));

    await vi.waitFor(() => expect(startDaimon).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(rpc.sendRequest).toHaveBeenCalledWith(
      'conversations.send',
      expect.objectContaining({ conversationKey: 'desktop-local-chat:conversation:2', text: 'second' }),
    ));

    rpc.emitNotification('conversations.message.snapshot', {
      conversationKey: 'desktop-local-chat:conversation:1',
      turnId: 'turn-1',
      message: {
        id: 'message-1', role: 'assistant', status: 'streaming',
        parts: [
          { kind: 'reasoning', text: 'think' },
          { kind: 'text', text: 'hel' },
          { kind: 'tool-call', toolCallId: 'tool-1', toolName: 'Bash', input: { command: 'pwd' } },
          { kind: 'tool-result', toolCallId: 'tool-1', toolName: 'Bash', output: '/tmp' },
        ],
      },
    });
    rpc.emitNotification('conversations.message.complete', {
      conversationKey: 'desktop-local-chat:conversation:1',
      turnId: 'turn-1',
      message: {
        id: 'message-1', role: 'assistant', status: 'complete',
        parts: [{ kind: 'text', text: 'hello' }],
      },
    });

    await vi.waitFor(() => expect(firstEvents).toContainEqual({
      type: 'result', sessionId: 'desktop-local-chat:conversation:1',
    }));
    expect(firstEvents).toEqual(expect.arrayContaining([
      { type: 'thinking', content: 'think' },
      { type: 'text', content: 'hel' },
      { type: 'text', content: 'lo' },
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
      { type: 'tool_result', id: 'tool-1', name: 'Bash', output: '/tmp' },
    ]));
    expect(secondEvents).not.toContainEqual(expect.objectContaining({ type: 'text' }));
  });

  it('falls back to complete text when no snapshot text was emitted', async () => {
    const proc = plugin.spawn(opts);
    const events = collectEvents(proc);
    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'short' }));
    await vi.waitFor(() => expect(proc.sessionId).not.toBe(''));

    rpc.emitNotification('conversations.message.complete', {
      conversationKey: proc.sessionId,
      turnId: 'turn-1',
      message: {
        id: 'message-1', role: 'assistant', status: 'complete',
        parts: [{ kind: 'text', text: '收到' }],
      },
    });

    await vi.waitFor(() => expect(events).toContainEqual({ type: 'text', content: '收到' }));
    expect(events).toContainEqual({ type: 'result', sessionId: proc.sessionId });
  });

  it('ignores a duplicate completed turn after the next turn has started', async () => {
    const proc = plugin.spawn(opts);
    const events = collectEvents(proc);
    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'first' }));
    await vi.waitFor(() => expect(proc.sessionId).not.toBe(''));
    const complete = (turnId: string, text: string) => rpc.emitNotification('conversations.message.complete', {
      conversationKey: proc.sessionId,
      turnId,
      message: {
        id: `message-${turnId}`, role: 'assistant', status: 'complete',
        parts: [{ kind: 'text', text }],
      },
    });
    complete('turn-1', 'one');
    await vi.waitFor(() => expect(events.filter((event) => event.type === 'result')).toHaveLength(1));

    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'second' }));
    await vi.waitFor(() => expect(rpc.sendRequest.mock.calls.filter(
      ([method]) => method === 'conversations.send',
    )).toHaveLength(2));
    complete('turn-1', 'one');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events.filter((event) => event.type === 'result')).toHaveLength(1);

    complete('turn-2', 'two');
    await vi.waitFor(() => expect(events.filter((event) => event.type === 'result')).toHaveLength(2));
  });

  it('maps interaction.pending to permission_request and responds with interactionId', async () => {
    const proc = plugin.spawn(opts);
    const events = collectEvents(proc);
    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'delete it' }));
    await vi.waitFor(() => expect(proc.sessionId).not.toBe(''));

    rpc.emitNotification('interaction.pending', {
      interaction: {
        id: 'ci_1', kind: 'tool-approval', createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
        input: { command: 'rm file' },
        turn: { conversationKey: proc.sessionId, toolCallId: 'tool-1', toolName: 'Bash' },
      },
    });
    await vi.waitFor(() => expect(events).toContainEqual({
      type: 'permission_request', id: 'ci_1', tool: 'Bash', input: { command: 'rm file' },
    }));

    proc.stdin.write(plugin.formatPermissionResponse('ci_1', 'deny'));
    await vi.waitFor(() => expect(rpc.sendRequest).toHaveBeenCalledWith('interaction.respond', {
      interactionId: 'ci_1', response: { decision: 'rejected', feedback: 'Denied by user' },
    }));
  });

  it('auto-approves interactions when autoApprove is enabled', async () => {
    const proc = plugin.spawn({ ...opts, autoApprove: true });
    const events = collectEvents(proc);
    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'run it' }));
    await vi.waitFor(() => expect(proc.sessionId).not.toBe(''));

    rpc.emitNotification('interaction.pending', {
      interaction: {
        id: 'ci_auto', kind: 'tool-approval', createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
        turn: { conversationKey: proc.sessionId, toolCallId: 'tool-1', toolName: 'Bash' },
      },
    });

    await vi.waitFor(() => expect(rpc.sendRequest).toHaveBeenCalledWith('interaction.respond', {
      interactionId: 'ci_auto', response: { decision: 'approved' },
    }));
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'permission_request' }));
  });

  it('never auto-resends on a JSON-RPC error (could have started a turn)', async () => {
    // A JSON-RPC error does not prove the turn was not created, so a resend
    // could double-charge quota or re-run tools — fail closed, do not retry.
    rpc.sendErrors.push(new KimiWorkRpcError(-32000, 'server error'));
    const proc = plugin.spawn(opts);
    const events = collectEvents(proc);
    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'do-once' }));

    await vi.waitFor(() => expect(events).toContainEqual({
      type: 'error',
      message: expect.stringContaining('未自动重发'),
    }));
    expect(rpc.sendRequest.mock.calls.filter(([method]) => method === 'conversations.send')).toHaveLength(1);
    proc.kill();
  });

  it('fails closed on an uncertain send and never resends or reconciles', async () => {
    rpc.sendErrors.push(new Error('response lost'));
    const proc = plugin.spawn(opts);
    const events = collectEvents(proc);
    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'do-once' }));

    await vi.waitFor(() => expect(events).toContainEqual({
      type: 'error',
      message: expect.stringContaining('未自动重发'),
    }));
    // Transport loss: no blind resend, and no getMessages guesswork.
    expect(rpc.sendRequest.mock.calls.filter(([method]) => method === 'conversations.send')).toHaveLength(1);
    expect(rpc.sendRequest).not.toHaveBeenCalledWith('conversations.getMessages', expect.anything());
    proc.kill();
  });

  it('still fails closed even when a matching historical user message exists', async () => {
    // Guards against a false-positive reconcile: a same-text message from an
    // earlier turn must NOT be treated as proof the lost send was accepted.
    rpc.sendErrors.push(new Error('response lost'));
    rpc.messages = [{
      id: 'message-user',
      role: 'user',
      status: 'complete',
      turnId: 'turn-old',
      parts: [{ kind: 'text', text: 'do-once' }],
    }];
    const proc = plugin.spawn(opts);
    const events = collectEvents(proc);
    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'do-once' }));

    await vi.waitFor(() => expect(events).toContainEqual({
      type: 'error',
      message: expect.stringContaining('未自动重发'),
    }));
    expect(rpc.sendRequest.mock.calls.filter(([method]) => method === 'conversations.send')).toHaveLength(1);
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'result' }));
    proc.kill();
  });

  it('shutdown resolves and kills the daimon even if daemon.shutdown never responds', async () => {
    const hang = new Promise<never>(() => {});
    rpc.sendRequest.mockImplementation(async (method: string, params?: any) => {
      if (method === 'conversations.create') {
        return {
          agentId: 'main',
          session: { activeConversationKey: 'desktop-local-chat:conversation:hang' },
          conversation: {},
        } as any;
      }
      if (method === 'conversations.send') {
        return { accepted: true, turnId: 'turn-hang', conversationKey: params.conversationKey } as any;
      }
      if (method === 'daemon.shutdown') return hang as any; // never resolves
      return {} as any;
    });
    const proc = plugin.spawn(opts);
    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'hi' }));
    await vi.waitFor(() => expect(proc.sessionId).not.toBe(''));

    vi.useFakeTimers();
    try {
      const done = plugin.shutdown();
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(done).resolves.toBeUndefined();
      expect(rpc.dispose).toHaveBeenCalled();
      expect(child.kill).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a conversation created during bootstrap when killed mid-setActive', async () => {
    let releaseSetActive: () => void = () => {};
    const setActiveGate = new Promise<void>((resolve) => { releaseSetActive = resolve; });
    rpc.sendRequest.mockImplementation(async (method: string) => {
      if (method === 'conversations.create') {
        return {
          agentId: 'main',
          session: { activeConversationKey: 'desktop-local-chat:conversation:boot' },
          conversation: {},
        } as any;
      }
      if (method === 'conversations.setActive') { await setActiveGate; return {} as any; }
      return {} as any;
    });
    const proc = plugin.spawn(opts);
    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'hi' }));
    await vi.waitFor(() => expect(rpc.sendRequest).toHaveBeenCalledWith('conversations.setActive', expect.anything()));

    proc.kill(); // cancel while setActive is still in flight (sessionId not set yet)
    releaseSetActive();

    await vi.waitFor(() => expect(rpc.sendRequest).toHaveBeenCalledWith('conversations.cancel', {
      conversationKey: 'desktop-local-chat:conversation:boot',
    }));
  });

  it('drops late permission responses after interaction.expired', async () => {
    const proc = plugin.spawn(opts);
    const events = collectEvents(proc);
    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'danger' }));
    await vi.waitFor(() => expect(proc.sessionId).not.toBe(''));
    rpc.emitNotification('interaction.pending', {
      interaction: {
        id: 'ci_expired', kind: 'tool-approval', createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
        turn: { conversationKey: proc.sessionId, toolCallId: 'tool-1', toolName: 'Bash' },
      },
    });
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
      type: 'permission_request', id: 'ci_expired',
    })));
    rpc.emitNotification('interaction.expired', {
      interactionId: 'ci_expired',
      turn: { conversationKey: proc.sessionId },
    });

    proc.stdin.write(plugin.formatPermissionResponse('ci_expired', 'allow'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rpc.sendRequest).not.toHaveBeenCalledWith('interaction.respond', expect.anything());
  });

  it('implements resume as a defensive fresh conversation', async () => {
    const proc = plugin.resume('stale-conversation', opts);
    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'fresh' }));

    await vi.waitFor(() => expect(proc.sessionId).toBe('desktop-local-chat:conversation:1'));
    expect(rpc.sendRequest).toHaveBeenCalledWith('conversations.create', {
      sessionKey: 'desktop-local-chat',
    });
    expect(rpc.sendRequest).not.toHaveBeenCalledWith('conversations.resume', expect.anything());
  });

  it('cancels only the virtual conversation and keeps the shared daimon alive until shutdown', async () => {
    const first = plugin.spawn(opts);
    const second = plugin.spawn(opts);
    first.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'first' }));
    second.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'second' }));
    await vi.waitFor(() => expect(second.sessionId).not.toBe(''));

    first.kill();
    await vi.waitFor(() => expect(rpc.sendRequest).toHaveBeenCalledWith('conversations.cancel', {
      conversationKey: first.sessionId,
    }));
    expect(child.kill).not.toHaveBeenCalled();

    second.kill();
    await vi.waitFor(() => expect(rpc.sendRequest).toHaveBeenCalledWith('conversations.cancel', {
      conversationKey: second.sessionId,
    }));
    expect(child.kill).not.toHaveBeenCalled();

    await plugin.shutdown();
    expect(rpc.sendRequest).toHaveBeenCalledWith('daemon.shutdown', {});
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('broadcasts a daimon crash once and cold-starts on the next spawn', async () => {
    const first = plugin.spawn(opts);
    const second = plugin.spawn(opts);
    const firstEvents = collectEvents(first);
    const secondEvents = collectEvents(second);
    const firstExit = vi.fn();
    const secondExit = vi.fn();
    first.on('exit', firstExit);
    second.on('exit', secondExit);
    first.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'first' }));
    second.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'second' }));
    await vi.waitFor(() => expect(first.sessionId).not.toBe(''));
    await vi.waitFor(() => expect(second.sessionId).not.toBe(''));

    child.emit('exit', 1);
    rpc.handlers.onClose?.(1006, 'lost');
    await vi.waitFor(() => expect(firstExit).toHaveBeenCalledTimes(1));
    expect(secondExit).toHaveBeenCalledTimes(1);
    expect(firstEvents.filter((event) => event.type === 'error')).toHaveLength(1);
    expect(secondEvents.filter((event) => event.type === 'error')).toHaveLength(1);

    const nextChild = new FakeChild();
    const nextRpc = new FakeRpc();
    startDaimon.mockResolvedValueOnce({
      child: nextChild as unknown as ChildProcess,
      url: 'ws://127.0.0.1:5678/control', token: 'next-token',
      nodePath: '/node', shareDir: '/share', configPath: '/share/config.json',
    });
    rpcQueue.push(nextRpc);

    const restarted = plugin.spawn(opts);
    restarted.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'after-crash' }));
    await vi.waitFor(() => expect(startDaimon).toHaveBeenCalledTimes(2));
  });

  it('broadcasts startup crashes to virtual processes that do not have a conversationKey yet', async () => {
    const connectGate = deferred<void>();
    rpc.connect.mockReturnValue(connectGate.promise);
    const proc = plugin.spawn(opts);
    const events = collectEvents(proc);
    const exit = vi.fn();
    proc.on('exit', exit);
    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'during-start' }));
    await vi.waitFor(() => expect(rpc.connect).toHaveBeenCalledTimes(1));

    child.emit('exit', 1);

    await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1));
    expect(events).toContainEqual({
      type: 'error',
      message: expect.stringContaining('kimi-work daimon 已退出'),
    });
    connectGate.reject(new Error('closed'));
  });
});

function collectEvents(proc: AgentProcess): AgentEvent[] {
  const events: AgentEvent[] = [];
  proc.stdout.on('data', (event: AgentEvent) => events.push(event));
  return events;
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
