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
    private sendErrors: any[] = [];
    private persistentSendError: any;
    private subscribeErrors: any[] = [];
    // Each session/create|resume pushes a waiter that releaseBootstrap() /
    // failBootstrap() settles in order. Supports the -32031 reset path, which
    // issues a second session/create.
    private createWaiters: Array<{ resolve: (v: any) => void; reject: (e: any) => void }> = [];

    constructor(_child: any, handlers: any) {
      this.handlers = handlers;
      reg.instances.push(this);
    }

    sendRequest(method: string, params?: any): Promise<any> {
      if (method === 'session/create' || method === 'session/resume') {
        return new Promise((resolve, reject) => {
          this.createWaiters.push({ resolve, reject });
        });
      }
      if (method === 'session/send') {
        this.sends.push(params);
        const err = this.sendErrors.shift() ?? this.persistentSendError;
        if (err) return Promise.reject(err);
        return Promise.resolve({});
      }
      if (method === 'session/subscribe') {
        const err = this.subscribeErrors.shift();
        if (err) return Promise.reject(err);
        return Promise.resolve({});
      }
      // anything else: resolve immediately.
      return Promise.resolve({});
    }

    sendNotification(): void {}
    sendResponse(): void {}
    dispose(): void {}
    onLog(): void {}

    // --- test helpers ---
    releaseBootstrap(sessionId = 'ses_test'): void {
      this.createWaiters.shift()?.resolve({ session: { sessionId } });
    }
    failBootstrap(err: any): void {
      this.createWaiters.shift()?.reject(err);
    }
    emitEvent(env: any): void {
      this.handlers.onSessionEvent?.(env);
    }
    failNextSend(err: any): void {
      this.sendErrors.push(err);
    }
    // Make EVERY subsequent session/send fail with this error (until cleared).
    // Used to exhaust the same-session retry loop so the rebuild path is hit.
    failAllSends(err: any): void {
      this.persistentSendError = err;
    }
    clearSendErrors(): void {
      this.sendErrors = [];
      this.persistentSendError = undefined;
    }
    failNextSubscribe(err: any): void {
      this.subscribeErrors.push(err);
    }
  }

  return {
    ...actual,
    spawnZcodeAppServer: vi.fn(() => ({ pid: 9999 })),
    ZcodeRpcClient: FakeRpcClient,
  };
});

import { ZcodePlugin } from '../src/agents/zcode.js';
import { ZcodeRpcError } from '../src/agents/zcode-protocol.js';
import type { SpawnOpts } from '../src/types.js';

// Make the same-session retry loop instant in tests so the rebuild path is
// exercised quickly and deterministically.
process.env.ZCODE_SEND_RETRY_DELAY_MS = '0';
process.env.ZCODE_SEND_RETRY_MAX = '2';

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

// Wait long enough for the same-session retry loop (sleep(0) between attempts)
// plus the rebuild to settle. setImmediate (nextTick) runs before setTimeout,
// so a single nextTick doesn't reach the retries.
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50));
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

  // Regression (Codex review on #2): when the first send fails, the prompt
  // queued during bootstrap must still drain in order, not get stranded and
  // later run behind a newer message.
  it('drains a bootstrap-queued prompt in order when the first send fails', async () => {
    const plugin = new ZcodePlugin('/path/to/zcode.cjs');
    const proc = plugin.spawn(baseOpts());
    const rpc = lastRpc();
    rpc.failNextSend(new Error('send boom')); // first session/send rejects

    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'first' }));
    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'second' }));
    rpc.releaseBootstrap('ses_1');
    await nextTick();
    await nextTick();

    // First send attempted (and failed); the queued second drained right after,
    // preserving order — not left dangling for a future message.
    expect(rpc.sends.map((s: any) => s.content)).toEqual(['first', 'second']);
  });

  // Codex review on #2 (round 2): a bootstrap failure with a message queued
  // behind `driving` must not silently discard it. emitError does not recycle
  // the process, so we surface the queued failure and terminate (exit) to force
  // a cold start on the next message.
  it('surfaces queued prompts and terminates when bootstrap fails', async () => {
    const plugin = new ZcodePlugin('/path/to/zcode.cjs');
    const proc = plugin.spawn(baseOpts());
    const rpc = lastRpc();
    const events: AgentEvent[] = [];
    const exits: Array<number | null> = [];
    proc.stdout.on('data', (e: AgentEvent) => events.push(e));
    proc.on('exit', (code: number | null) => exits.push(code));

    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'first' }));
    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'second' }));
    rpc.failBootstrap(new Error('create boom'));
    await nextTick();
    await nextTick();

    // No turn ever started.
    expect(rpc.sends).toHaveLength(0);
    // Bootstrap failure surfaced, and the queued prompt was not dropped silently.
    const errors = events.filter((e: any) => e.type === 'error') as Array<{ message: string }>;
    expect(errors.some((e) => /启动失败/.test(e.message))).toBe(true);
    expect(errors.some((e) => /排队消息/.test(e.message))).toBe(true);
    // Process terminated so the manager cold-starts a fresh one next message.
    expect(exits).toEqual([null]);
  });

  // Codex review on #2 (round 3): on -32031, resetToFreshSession() clears
  // sessionId; if its bootstrap then fails, the send-failure path must not fall
  // through to the drain (runTurn would return on !sessionId and silently drop
  // the queued prompt). It must surface the queue and terminate instead.
  it('surfaces queued prompts and terminates when the -32031 reset bootstrap fails', async () => {
    const plugin = new ZcodePlugin('/path/to/zcode.cjs');
    const proc = plugin.spawn(baseOpts());
    const rpc = lastRpc();
    const events: AgentEvent[] = [];
    const exits: Array<number | null> = [];
    proc.stdout.on('data', (e: AgentEvent) => events.push(e));
    proc.on('exit', (code: number | null) => exits.push(code));

    // Persistent -32031 exhausts the same-session retries, then the rebuild
    // path fires a 2nd session/create which we fail.
    rpc.failAllSends(new ZcodeRpcError(-32031, 'model gone'));

    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'first' }));
    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'second' }));
    rpc.releaseBootstrap('ses_1'); // initial bootstrap succeeds
    await settle(); // send 'first' fires, -32031 persists across retries → reset issues a 2nd create
    rpc.failBootstrap(new Error('reset create boom')); // the reset bootstrap fails
    await settle();

    // 'first' retried twice on the same session (both -32031), then rebuild
    // attempted but its bootstrap failed → 'second' NOT shifted onto an empty
    // session.
    expect(rpc.sends.map((s: any) => s.content)).toEqual(['first', 'first']);
    const errors = events.filter((e: any) => e.type === 'error') as Array<{ message: string }>;
    expect(errors.some((e) => /失败/.test(e.message))).toBe(true);
    expect(errors.some((e) => /排队消息/.test(e.message))).toBe(true);
    expect(exits).toEqual([null]);
  });

  // Counterpart to the above: if the -32031 reset SUCCEEDS but the retry send
  // fails on the now-live session, that's an ordinary send failure — queued
  // prompts should drain on the live session, not trigger a terminate.
  it('drains queued prompts when the -32031 retry send fails on a live reset session', async () => {
    const plugin = new ZcodePlugin('/path/to/zcode.cjs');
    const proc = plugin.spawn(baseOpts());
    const rpc = lastRpc();
    const exits: Array<number | null> = [];
    proc.on('exit', (code: number | null) => exits.push(code));

    // Two -32031s exhaust the same-session retries; the rebuild then fires,
    // and its one retry send fails with -32010 (a non-recoverable error on the
    // live rebuilt session → ordinary drain, not terminate).
    rpc.failNextSend(new ZcodeRpcError(-32031, 'model gone')); // send #1 (same session)
    rpc.failNextSend(new ZcodeRpcError(-32031, 'model gone')); // send #2 (same session retry)
    rpc.failNextSend(new ZcodeRpcError(-32010, 'turn running')); // send #3 (rebuilt session)

    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'first' }));
    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'second' }));
    rpc.releaseBootstrap('ses_1'); // initial bootstrap
    await settle(); // first send → -32031 ×2 → reset issues a 2nd create
    rpc.releaseBootstrap('ses_2'); // reset succeeds → live session
    await settle();

    // 'first' attempted 3× (2 same-session retries + 1 on rebuilt session);
    // the rebuilt-session send failed (-32010) so 'second' drained onto the
    // live session. No terminate.
    expect(rpc.sends.map((s: any) => s.content)).toEqual(['first', 'first', 'first', 'second']);
    expect(exits).toEqual([]);
  });

  // Codex review on #2 (round 4): doBootstrap assigns sessionId before awaiting
  // session/subscribe, so a subscribe failure during the -32031 reset leaves a
  // non-empty but unusable sessionId. The retry catch must still treat this as
  // unrecoverable (bail), not as a live-session retry failure (drain), or the
  // queued prompt would be sent to a session that never delivers turn.completed.
  it('bails when the -32031 reset creates a session but subscribe fails', async () => {
    const plugin = new ZcodePlugin('/path/to/zcode.cjs');
    const proc = plugin.spawn(baseOpts());
    const rpc = lastRpc();
    const events: AgentEvent[] = [];
    const exits: Array<number | null> = [];
    proc.stdout.on('data', (e: AgentEvent) => events.push(e));
    proc.on('exit', (code: number | null) => exits.push(code));

    // Two -32031s exhaust the same-session retries, triggering the rebuild.
    rpc.failNextSend(new ZcodeRpcError(-32031, 'model gone'));
    rpc.failNextSend(new ZcodeRpcError(-32031, 'model gone'));

    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'first' }));
    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'second' }));
    rpc.releaseBootstrap('ses_1'); // initial bootstrap (subscribe ok)
    await settle(); // send 'first' → -32031 ×2 → reset issues a 2nd create
    rpc.failNextSubscribe(new Error('subscribe boom')); // reset's subscribe will reject
    rpc.releaseBootstrap('ses_2'); // reset create ok → sessionId set → subscribe rejects
    await settle();

    // Reset bootstrap failed at subscribe → unrecoverable → bail. 'second' is
    // NOT drained onto the dead session; process terminates for a cold start.
    expect(rpc.sends.map((s: any) => s.content)).toEqual(['first', 'first']);
    const errors = events.filter((e: any) => e.type === 'error') as Array<{ message: string }>;
    expect(errors.some((e) => /排队消息/.test(e.message))).toBe(true);
    expect(exits).toEqual([null]);
  });
});
