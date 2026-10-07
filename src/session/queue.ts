import type { InboundMessage } from '../types.js';

interface QueuedTask {
  task: () => Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface QueueState {
  pending: QueuedTask[];
  running: boolean;
  controlCount: number;
  controls: Promise<void>;
  idle: Array<() => void>;
}

export class QueueCancelledError extends Error {
  constructor() {
    super('Queued task cancelled');
    this.name = 'QueueCancelledError';
  }
}

export class ChatQueue {
  private queues = new Map<string, QueueState>();

  /** Key must include platform, chat/thread scope, and bot; never just chatId. */
  enqueue(sessionKey: string, task: () => Promise<void>): Promise<void> {
    const state = this.get(sessionKey);
    const result = new Promise<void>((resolve, reject) => {
      state.pending.push({ task, resolve, reject });
    });
    queueMicrotask(() => this.pump(sessionKey, state));
    return result;
  }

  /** Authorized controls (especially stop) bypass long normal tasks. */
  control(sessionKey: string, task: () => Promise<void>): Promise<void> {
    const state = this.get(sessionKey);
    state.controlCount++;
    const result = state.controls.then(task, task);
    state.controls = result.catch(() => {}).then(() => {
      state.controlCount--;
      this.pump(sessionKey, state);
    });
    return result;
  }

  /** Cancels work that has not started; active agent cancellation belongs to its owner. */
  cancelPending(sessionKey: string): number {
    const state = this.queues.get(sessionKey);
    if (!state) return 0;
    const cancelled = state.pending.splice(0);
    for (const entry of cancelled) entry.reject(new QueueCancelledError());
    this.cleanup(sessionKey, state);
    return cancelled.length;
  }

  status(sessionKey: string): { running: boolean; pending: number; controls: number } {
    const state = this.queues.get(sessionKey);
    return { running: state?.running ?? false, pending: state?.pending.length ?? 0, controls: state?.controlCount ?? 0 };
  }

  keys(): string[] {
    return [...this.queues.keys()];
  }

  async drain(sessionKey: string): Promise<void> {
    const state = this.queues.get(sessionKey);
    if (!state) return;
    await new Promise<void>((resolve) => state.idle.push(resolve));
  }

  private get(sessionKey: string): QueueState {
    let state = this.queues.get(sessionKey);
    if (!state) {
      state = { pending: [], running: false, controlCount: 0, controls: Promise.resolve(), idle: [] };
      this.queues.set(sessionKey, state);
    }
    return state;
  }

  private pump(sessionKey: string, state: QueueState): void {
    if (state.running || state.controlCount) return;
    const entry = state.pending.shift();
    if (!entry) {
      this.cleanup(sessionKey, state);
      return;
    }
    state.running = true;
    // Once dequeued, start immediately; an async wrapper captures synchronous throws.
    void (async () => entry.task())().then(entry.resolve, entry.reject).finally(() => {
      state.running = false;
      this.pump(sessionKey, state);
    });
  }

  private cleanup(sessionKey: string, state: QueueState): void {
    if (state.running || state.controlCount || state.pending.length) return;
    if (this.queues.get(sessionKey) === state) this.queues.delete(sessionKey);
    for (const resolve of state.idle.splice(0)) resolve();
  }
}

interface MessageBatch {
  message: InboundMessage;
  count: number;
  handler: (message: InboundMessage) => Promise<void>;
  timer: ReturnType<typeof setTimeout>;
  waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }>;
}

export interface MessageBatcherOptions {
  delayMs?: number;
  maxMessages?: number;
  maxChars?: number;
}

/** Call only after admission checks. No persistence and no cross-sender merging. */
export class MessageBatcher {
  private batches = new Map<string, MessageBatch>();
  private delayMs: number;
  private maxMessages: number;
  private maxChars: number;

  constructor(private queue: ChatQueue, options: MessageBatcherOptions = {}) {
    this.delayMs = Math.max(0, Math.min(5_000, options.delayMs ?? 800));
    this.maxMessages = Math.max(1, Math.min(20, options.maxMessages ?? 8));
    this.maxChars = Math.max(1, options.maxChars ?? 32_000);
  }

  enqueue(sessionKey: string, message: InboundMessage, handler: (message: InboundMessage) => Promise<void>): Promise<void> {
    const command = message.text.trim().match(/^\/(\w+)(?:\s|$)/)?.[1];
    if (command === 'stop' || command === 'kill') {
      this.cancel(sessionKey);
      this.queue.cancelPending(sessionKey);
      return this.queue.control(sessionKey, () => handler(message));
    }
    if (command || !this.delayMs || message.isRelay) {
      this.flush(sessionKey);
      return this.queue.enqueue(sessionKey, () => handler(message));
    }

    let batch = this.batches.get(sessionKey);
    if (batch && (!compatible(batch.message, message)
      || batch.count >= this.maxMessages
      || batch.message.text.length + message.text.length + 2 > this.maxChars)) {
      this.flush(sessionKey);
      batch = undefined;
    }
    if (!batch) {
      batch = {
        message: { ...message, attachments: message.attachments?.map((attachment) => ({ ...attachment })) },
        count: 1,
        handler,
        timer: setTimeout(() => this.flush(sessionKey), this.delayMs),
        waiters: [],
      };
      this.batches.set(sessionKey, batch);
    } else {
      batch.message.text = [batch.message.text, message.text].filter(Boolean).join('\n\n');
      batch.message.attachments = [...(batch.message.attachments ?? []), ...(message.attachments ?? []).map((attachment) => ({ ...attachment }))];
      batch.count++;
      // Fixed maximum wait from the first message avoids starving long bursts.
    }
    return new Promise<void>((resolve, reject) => batch!.waiters.push({ resolve, reject }));
  }

  /** Enqueues synchronously, preserving order relative to the following command. */
  flush(sessionKey: string): void {
    const batch = this.batches.get(sessionKey);
    if (!batch) return;
    clearTimeout(batch.timer);
    this.batches.delete(sessionKey);
    void this.queue.enqueue(sessionKey, () => batch.handler(batch.message)).then(
      () => { for (const waiter of batch.waiters) waiter.resolve(); },
      (error) => { for (const waiter of batch.waiters) waiter.reject(error); },
    );
  }

  cancel(sessionKey: string): number {
    const batch = this.batches.get(sessionKey);
    if (!batch) return 0;
    clearTimeout(batch.timer);
    this.batches.delete(sessionKey);
    for (const waiter of batch.waiters) waiter.reject(new QueueCancelledError());
    return batch.count;
  }

  pending(sessionKey: string): number {
    return this.batches.get(sessionKey)?.count ?? 0;
  }

  keys(): string[] {
    return [...this.batches.keys()];
  }
}

function compatible(first: InboundMessage, next: InboundMessage): boolean {
  return first.platform === next.platform
    && first.chatId === next.chatId
    && first.threadId === next.threadId
    && first.userId === next.userId
    && first.replyTo === next.replyTo
    && first.chatType === next.chatType
    && first.isVoice === next.isVoice
    && first.isRelay === next.isRelay
    && JSON.stringify(first.mentions ?? []) === JSON.stringify(next.mentions ?? []);
}
