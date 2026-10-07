import { describe, expect, it, vi } from 'vitest';
import { PreparationGuard } from '../src/runtime/preparation-guard.js';
import { QueueCancelledError } from '../src/session/queue.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('cancelling preparation before agent launch', () => {
  it('does not launch after a cancelled attachment download eventually completes', async () => {
    const guard = new PreparationGuard();
    const download = deferred();
    const spawn = vi.fn();
    const key = 'feishu:chat:bot';
    const ensureCurrent = guard.capture(key);
    const processing = (async () => {
      await download.promise;
      ensureCurrent();
      spawn();
    })().catch((error) => error);
    guard.cancel(key);
    download.resolve();
    expect(await processing).toBeInstanceOf(QueueCancelledError);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('cancels all preparing topics of one bot without cancelling another bot', async () => {
    const guard = new PreparationGuard();
    const download = deferred();
    const spawned: string[] = [];
    const keys = ['feishu:chat:first:topic1', 'feishu:chat:first:topic2', 'feishu:chat:second'];
    const processing = keys.map((key) => {
      const ensureCurrent = guard.capture(key);
      return (async () => {
        await download.promise;
        ensureCurrent();
        spawned.push(key);
      })().catch((error) => error);
    });
    guard.cancelBot('first');
    download.resolve();
    const results = await Promise.all(processing);
    expect(results[0]).toBeInstanceOf(QueueCancelledError);
    expect(results[1]).toBeInstanceOf(QueueCancelledError);
    expect(results[2]).toBeUndefined();
    expect(spawned).toEqual(['feishu:chat:second']);
  });

  it('allows a later deliberate task while an older preparation remains invalid', () => {
    const guard = new PreparationGuard();
    const old = guard.capture('feishu:chat:bot');
    guard.cancel('feishu:chat:bot');
    const next = guard.capture('feishu:chat:bot');
    expect(old).toThrow(QueueCancelledError);
    expect(next).not.toThrow();
  });
});
