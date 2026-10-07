import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatQueue, MessageBatcher, QueueCancelledError } from '../src/session/queue.js';
import type { InboundMessage } from '../src/types.js';

const message = (text: string, extra: Partial<InboundMessage> = {}): InboundMessage => ({ platform: 'feishu', chatId: 'chat', userId: 'alice', text, ...extra });
afterEach(() => vi.useRealTimers());

describe('message batching', () => {
  it('preserves message and attachment order without mutating source messages', async () => {
    vi.useFakeTimers();
    const batching = new MessageBatcher(new ChatQueue(), { delayMs: 500 });
    const handler = vi.fn(async (_msg: InboundMessage) => {});
    const first = message('one', { attachments: [{ type: 'file', fileName: 'one.txt' }] });
    const firstPromise = batching.enqueue('feishu:chat:bot', first, handler);
    const secondPromise = batching.enqueue('feishu:chat:bot', message('two', { attachments: [{ type: 'image', fileName: 'two.png' }] }), handler);
    await vi.advanceTimersByTimeAsync(500);
    await Promise.all([firstPromise, secondPromise]);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].text).toBe('one\n\ntwo');
    expect(handler.mock.calls[0][0].attachments?.map((file) => file.fileName)).toEqual(['one.txt', 'two.png']);
    expect(first.text).toBe('one');
    expect(first.attachments).toHaveLength(1);
  });

  it.each([{ userId: 'bob' }, { replyTo: 'different' }, { threadId: 'another-thread' }, { mentions: ['another-bot'] }])('does not combine different senders or scopes: %o', async (extra) => {
    vi.useFakeTimers();
    const batching = new MessageBatcher(new ChatQueue(), { delayMs: 500 });
    const seen: string[] = [];
    const handler = async (msg: InboundMessage) => { seen.push(msg.text); };
    const first = batching.enqueue('feishu:chat:bot', message('one'), handler);
    const second = batching.enqueue('feishu:chat:bot', message('two', extra), handler);
    await vi.advanceTimersByTimeAsync(500);
    await Promise.all([first, second]);
    expect(seen).toEqual(['one', 'two']);
  });

  it('flushes previous text before a normal command', async () => {
    const batching = new MessageBatcher(new ChatQueue(), { delayMs: 5_000 });
    const seen: string[] = [];
    const handler = async (msg: InboundMessage) => { seen.push(msg.text); };
    const first = batching.enqueue('feishu:chat:bot', message('one'), handler);
    const next = batching.enqueue('feishu:chat:bot', message('/projects'), handler);
    await Promise.all([first, next]);
    expect(seen).toEqual(['one', '/projects']);
  });

  it('lets authorized stop cancel buffered and queued work without waiting for an active task', async () => {
    const queue = new ChatQueue();
    const batching = new MessageBatcher(queue);
    let finish!: () => void;
    const active = queue.enqueue('feishu:chat:bot', async () => new Promise<void>((resolve) => { finish = resolve; }));
    await Promise.resolve();
    const queued = queue.enqueue('feishu:chat:bot', async () => { throw new Error('should never run'); }).catch((error) => error);
    const buffered = batching.enqueue('feishu:chat:bot', message('buffered'), async () => {}).catch((error) => error);
    const stop = vi.fn(async () => {});
    await batching.enqueue('feishu:chat:bot', message('/stop'), stop);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(await queued).toBeInstanceOf(QueueCancelledError);
    expect(await buffered).toBeInstanceOf(QueueCancelledError);
    finish();
    await active;
    await queue.drain('feishu:chat:bot');
    expect(queue.keys()).toEqual([]);
  });

  it('does not let a slow bot block another bot in the same chat', async () => {
    const queue = new ChatQueue();
    let finish!: () => void;
    const blocked = queue.enqueue('feishu:chat:first', async () => new Promise<void>((resolve) => { finish = resolve; }));
    await Promise.resolve();
    const handled = vi.fn(async () => {});
    await queue.enqueue('feishu:chat:second', handled);
    expect(handled).toHaveBeenCalledTimes(1);
    finish();
    await blocked;
    await queue.drain('feishu:chat:first');
  });

  it.each(['/stop', '/kill'])('cancels an enqueued task that has not started before an immediate %s', async (command) => {
    const queue = new ChatQueue();
    const batching = new MessageBatcher(queue, { delayMs: 0 });
    const handler = vi.fn(async (_message: InboundMessage) => {});
    const pending = batching.enqueue('feishu:chat:bot', message('do work'), handler).catch((error) => error);
    await batching.enqueue('feishu:chat:bot', message(command), handler);
    expect(await pending).toBeInstanceOf(QueueCancelledError);
    expect(handler.mock.calls.map(([msg]) => msg.text)).toEqual([command]);
  });

  it('limits batch size so continuing bursts cannot grow without bound', async () => {
    vi.useFakeTimers();
    const batching = new MessageBatcher(new ChatQueue(), { delayMs: 500, maxMessages: 2 });
    const handler = vi.fn(async (_msg: InboundMessage) => {});
    const promises = ['one', 'two', 'three'].map((text) => batching.enqueue('feishu:chat:bot', message(text), handler));
    await vi.advanceTimersByTimeAsync(500);
    await Promise.all(promises);
    expect(handler.mock.calls.map(([msg]) => msg.text)).toEqual(['one\n\ntwo', 'three']);
  });
});
