import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentEvent } from '../src/types.js';

// Shared registry so each test can grab the FakeRpcClient the virtual process
// just constructed and drive its bootstrap timing / emit wire events.
const reg = vi.hoisted(() => ({ instances: [] as any[] }));

vi.mock('../src/agents/zcode-protocol.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/agents/zcode-protocol.js')>();

  // A controllable stand-in for ZcodeRpcClient. session/create stays pending
  // until the test calls releaseBootstrap(), which is exactly the window the
  // P1 race lives in; session/send is recorded so we can assert how many
  // concurrent sends were issued.
  class FakeRpcClient {
    handlers: any;
    sends: any[] = [];
    private resolveCreate!: (v: any) => void;
    private createPromise: Promise<any>;

    constructor(_child: any, handlers: any) {
      this.handlers = handlers;
      this.createPromise = new Promise((res) => {
        this.resolveCreate = res;
      });
      reg.instances.push(this);
    }

    sendRequest(method: string, params?: any): Promise<any> {
      if (method === 'session/create' || method === 'session/resume') {
        return this.createPromise;
      }
      if (method === 'session/send') {
        this.sends.push(params);
        return Promise.resolve({});
      }
      // session/subscribe and anything else: resolve immediately.
      return Promise.resolve({});
    }

    sendNotification(): void {}
    sendResponse(): void {}
    dispose(): void {}
    onLog(): void {}

    // --- test helpers ---
    releaseBootstrap(sessionId = 'ses_test'): void {
      this.resolveCreate({ session: { sessionId } });
    }
    emitEvent(env: any): void {
      this.handlers.onSessionEvent?.(env);
    }
  }

  return {
    ...actual,
    spawnZcodeAppServer: vi.fn(() => ({ pid: 9999 })),
    ZcodeRpcClient: FakeRpcClient,
  };
});

import { ZcodePlugin } from '../src/agents/zcode.js';
import type { SpawnOpts } from '../src/types.js';

function baseOpts(overrides: Partial<SpawnOpts> = {}): SpawnOpts {
  return {
    workingDirectory: '/Users/test/project',
    permissionMode: 'bypass',
    ...overrides,
  };
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function lastRpc(): any {
  return reg.instances[reg.instances.length - 1];
}

describe('ZcodeVirtualProcess turn lifecycle', () => {
  beforeEach(() => {
    reg.instances.length = 0;
  });

  // P1: two messages reaching a fresh process before bootstrap resolves must
  // not both race into runTurn and fire concurrent session/send requests
  // ("turn already running"). The second one queues behind the first.
  it('queues a second message that arrives during bootstrap instead of racing', async () => {
    const plugin = new ZcodePlugin('/path/to/zcode.cjs');
    const proc = plugin.spawn(baseOpts());
    const rpc = lastRpc();

    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'first' }));
    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'second' }));
    await nextTick();

    // Bootstrap (session/create) still pending → no turn started yet.
    expect(rpc.sends).toHaveLength(0);

    rpc.releaseBootstrap('ses_1');
    await nextTick();

    // Only the first message drives a turn; the second is queued.
    expect(rpc.sends).toHaveLength(1);
    expect(rpc.sends[0].content).toBe('first');

    // Completing the first turn drains the queued second message.
    rpc.emitEvent({
      type: 'turn.completed',
      sessionId: 'ses_1',
      payload: { resultType: 'success', response: 'ok' },
    });
    await nextTick();

    expect(rpc.sends).toHaveLength(2);
    expect(rpc.sends[1].content).toBe('second');
  });

  // P1 #2: a failed turn must be caught (no unhandled rejection from the
  // `void enqueue(...)` caller) and must still drain queued prompts.
  it('drains queued prompts after a failed turn without an unhandled rejection', async () => {
    const rejections: unknown[] = [];
    const onRej = (e: unknown) => rejections.push(e);
    process.on('unhandledRejection', onRej);
    try {
      const plugin = new ZcodePlugin('/path/to/zcode.cjs');
      const proc = plugin.spawn(baseOpts());
      const rpc = lastRpc();
      const events: AgentEvent[] = [];
      proc.stdout.on('data', (e: AgentEvent) => events.push(e));

      proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'first' }));
      proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'second' }));
      rpc.releaseBootstrap('ses_1');
      await nextTick();
      expect(rpc.sends).toHaveLength(1);

      rpc.emitEvent({ type: 'turn.failed', sessionId: 'ses_1', payload: { message: 'boom' } });
      await nextTick();
      await nextTick();

      // Error surfaced, queued 'second' still ran, nothing escaped unhandled.
      expect(events).toContainEqual({ type: 'error', message: expect.stringContaining('boom') });
      expect(rpc.sends).toHaveLength(2);
      expect(rpc.sends[1].content).toBe('second');
      expect(rejections).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onRej);
    }
  });
});
