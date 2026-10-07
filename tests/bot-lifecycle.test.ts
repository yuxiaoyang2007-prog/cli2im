import { describe, expect, it, vi } from 'vitest';
import { BotLifecycle } from '../src/runtime/bot-lifecycle.js';

describe('independent bot lifecycle', () => {
  it('keeps healthy bots running when another fails during startup', async () => {
    const lifecycle = new BotLifecycle();
    const badStop = vi.fn(async () => {});
    lifecycle.register('bad', { start: async () => { throw new Error('credential detail'); }, stop: badStop });
    lifecycle.register('good', { start: async () => {}, stop: async () => {} });
    const results = await lifecycle.startAll();
    expect(results.map((result) => result.status)).toEqual(['rejected', 'fulfilled']);
    expect(lifecycle.status('good').acceptsMessages).toBe(true);
    expect(lifecycle.status('bad')).toMatchObject({ state: 'failed', acceptsMessages: false, error: 'start_failed' });
    expect(JSON.stringify(lifecycle.list())).not.toContain('credential');
    expect(badStop).toHaveBeenCalledWith({ mode: 'cancel' });
  });

  it('restarts only the requested bot, with owned-task cancellation delegated to its hook', async () => {
    const lifecycle = new BotLifecycle();
    const firstStart = vi.fn(async () => {});
    const firstStop = vi.fn(async () => {});
    const secondStop = vi.fn(async () => {});
    lifecycle.register('first', { start: firstStart, stop: firstStop });
    lifecycle.register('second', { start: async () => {}, stop: secondStop });
    await lifecycle.startAll();
    await lifecycle.restart('first', 'cancel');
    expect(firstStart).toHaveBeenCalledTimes(2);
    expect(firstStop).toHaveBeenCalledWith({ mode: 'cancel' });
    expect(secondStop).not.toHaveBeenCalled();
    expect(lifecycle.status('second').state).toBe('running');
  });

  it('rejects new admission while draining and does not start a disabled bot', async () => {
    const lifecycle = new BotLifecycle();
    const start = vi.fn(async () => {});
    let finish!: () => void;
    lifecycle.register('bot', { start, stop: async () => new Promise<void>((resolve) => { finish = resolve; }) }, { enabled: false });
    await lifecycle.startAll();
    expect(start).not.toHaveBeenCalled();
    expect(lifecycle.status('bot').state).toBe('disabled');
    await lifecycle.setEnabled('bot', true);
    const stopping = lifecycle.stop('bot');
    await vi.waitFor(() => expect(lifecycle.status('bot').state).toBe('stopping'));
    expect(lifecycle.status('bot').acceptsMessages).toBe(false);
    finish();
    await stopping;
    expect(lifecycle.status('bot').state).toBe('stopped');
  });

  it('serializes repeated start/restart requests without parallel connects', async () => {
    const lifecycle = new BotLifecycle();
    const calls: string[] = [];
    lifecycle.register('bot', { start: async () => { calls.push('start'); }, stop: async () => { calls.push('stop'); } });
    await Promise.all([lifecycle.start('bot'), lifecycle.start('bot'), lifecycle.restart('bot'), lifecycle.stop('bot')]);
    expect(calls).toEqual(['start', 'stop', 'start', 'stop']);
  });
});
