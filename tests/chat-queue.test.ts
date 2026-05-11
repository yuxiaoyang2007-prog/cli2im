import { describe, it, expect } from 'vitest';
import { ChatQueue } from '../src/session/queue.js';

describe('ChatQueue', () => {
  it('serializes tasks for same chatId', async () => {
    const queue = new ChatQueue();
    const order: number[] = [];

    const task = (n: number, delay: number) => () =>
      new Promise<void>((resolve) => {
        setTimeout(() => {
          order.push(n);
          resolve();
        }, delay);
      });

    // Task 1 takes 50ms, Task 2 takes 10ms
    // Without serialization, task 2 would finish first
    const p1 = queue.enqueue('chat1', task(1, 50));
    const p2 = queue.enqueue('chat1', task(2, 10));

    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });

  it('runs tasks for different chatIds in parallel', async () => {
    const queue = new ChatQueue();
    const order: string[] = [];

    const task = (label: string, delay: number) => () =>
      new Promise<void>((resolve) => {
        setTimeout(() => {
          order.push(label);
          resolve();
        }, delay);
      });

    const p1 = queue.enqueue('chat1', task('chat1-slow', 50));
    const p2 = queue.enqueue('chat2', task('chat2-fast', 10));

    await Promise.all([p1, p2]);
    expect(order[0]).toBe('chat2-fast');
  });

  it('continues after task failure', async () => {
    const queue = new ChatQueue();
    const order: number[] = [];

    const p1 = queue.enqueue('chat1', async () => {
      throw new Error('fail');
    });
    const p2 = queue.enqueue('chat1', async () => {
      order.push(2);
    });

    await p1.catch(() => {});
    await p2;
    expect(order).toEqual([2]);
  });
});
