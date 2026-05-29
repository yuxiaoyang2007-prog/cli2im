import { describe, expect, it } from 'vitest';
import { InputQueue } from '../src/agents/input-queue.js';

describe('InputQueue', () => {
  it('yields items pushed before consumption', async () => {
    const queue = new InputQueue<string>();
    queue.push('first');
    queue.push('second');
    queue.close();

    const received: string[] = [];
    for await (const item of queue) {
      received.push(item);
    }

    expect(received).toEqual(['first', 'second']);
  });

  it('wakes consumers waiting before push', async () => {
    const queue = new InputQueue<string>();
    const iterator = queue[Symbol.asyncIterator]();

    const next = iterator.next();
    queue.push('later');

    await expect(next).resolves.toEqual({ value: 'later', done: false });
  });

  it('ends pending consumers when closed', async () => {
    const queue = new InputQueue<string>();
    const iterator = queue[Symbol.asyncIterator]();

    const next = iterator.next();
    queue.close();

    await expect(next).resolves.toEqual({ value: undefined, done: true });
  });

  it('preserves push order across waiting and buffered reads', async () => {
    const queue = new InputQueue<number>();
    const iterator = queue[Symbol.asyncIterator]();

    const first = iterator.next();
    queue.push(1);
    queue.push(2);
    queue.push(3);
    queue.close();

    await expect(first).resolves.toEqual({ value: 1, done: false });
    await expect(iterator.next()).resolves.toEqual({ value: 2, done: false });
    await expect(iterator.next()).resolves.toEqual({ value: 3, done: false });
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
  });

  it('drains only items that have not been pulled by a consumer', async () => {
    const queue = new InputQueue<number>();
    const iterator = queue[Symbol.asyncIterator]();

    const first = iterator.next();
    queue.push(1);
    queue.push(2);
    queue.push(3);

    await expect(first).resolves.toEqual({ value: 1, done: false });
    expect(queue.drain()).toEqual([2, 3]);
    queue.close();

    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
  });
});
