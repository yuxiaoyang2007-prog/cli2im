import { describe, expect, it } from 'vitest';
import { TaskTracker } from '../src/runtime/task-tracker.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('task tracker', () => {
  it('prevents an old completion from overwriting a new task while result saving is delayed', async () => {
    const tracker = new TaskTracker();
    const save = deferred();
    const key = 'feishu:chat:bot';
    let preference = 'running';
    tracker.begin(key);
    const old = tracker.finish(key);
    expect(old.remaining).toBe(0);
    const continuation = (async () => {
      await save.promise;
      if (old.isCurrent()) preference = 'completed';
    })();
    tracker.begin(key);
    preference = 'running';
    save.resolve();
    await continuation;
    expect(old.isCurrent()).toBe(false);
    expect(preference).toBe('running');
    expect(tracker.size()).toBe(1);
  });

  it('counts several accepted turns in one persistent process until each finishes', () => {
    const tracker = new TaskTracker();
    const key = 'telegram:chat:bot';
    tracker.begin(key);
    tracker.begin(key);
    tracker.begin(key);
    expect(tracker.size()).toBe(1);
    const first = tracker.finish(key);
    expect(first.remaining).toBe(2);
    expect(first.isCurrent()).toBe(true);
    const second = tracker.finish(key);
    expect(second.remaining).toBe(1);
    expect(first.isCurrent()).toBe(false);
    const third = tracker.finish(key);
    expect(third.remaining).toBe(0);
    expect(second.isCurrent()).toBe(false);
    expect(third.isCurrent()).toBe(true);
    expect(tracker.size()).toBe(0);
    expect(tracker.keys()).toEqual([]);
  });

  it('invalidates a pending completion when cancelled and allows a deliberate fresh turn', async () => {
    const tracker = new TaskTracker();
    const save = deferred();
    const key = 'feishu:chat:bot:topic';
    tracker.begin(key);
    const old = tracker.finish(key);
    let wrotePreference = false;
    const continuation = (async () => {
      await save.promise;
      if (old.isCurrent()) wrotePreference = true;
    })();
    tracker.cancel(key);
    tracker.begin(key);
    save.resolve();
    await continuation;
    expect(wrotePreference).toBe(false);
    expect(tracker.finish(key).remaining).toBe(0);
  });

  it('only exposes running scope keys and does not cross bot or topic boundaries', () => {
    const tracker = new TaskTracker();
    const first = 'feishu:chat:first:topic1';
    const second = 'feishu:chat:second:topic1';
    const third = 'feishu:chat:first:topic2';
    for (const key of [first, second, third]) tracker.begin(key);
    const finishingOtherBot = tracker.finish(second);
    tracker.cancel(first);
    expect(finishingOtherBot.isCurrent()).toBe(true);
    expect(tracker.keys()).toEqual([third]);
    expect(tracker.size()).toBe(1);
  });

  it('never counts below zero and any later terminal invalidates the earlier completion', () => {
    const tracker = new TaskTracker();
    const first = tracker.finish('feishu:chat:bot');
    expect(first.remaining).toBe(0);
    const second = tracker.finish('feishu:chat:bot');
    expect(first.isCurrent()).toBe(false);
    expect(second.remaining).toBe(0);
    expect(tracker.size()).toBe(0);
    tracker.cancel('feishu:chat:bot');
    expect(second.isCurrent()).toBe(false);
  });
});
