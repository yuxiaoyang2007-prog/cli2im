import type { StructuredLifecycleEvent } from './lifecycle-protocol.js';
import { listOutboxEvents, removeOutboxEvent } from './task-state-files.js';

type Timer = ReturnType<typeof setInterval>;

export interface CodexNotificationOutboxOptions {
  dataRoot: string;
  handle: (event: StructuredLifecycleEvent) => Promise<unknown>;
  intervalMs?: number;
}

export class CodexNotificationOutbox {
  private readonly dataRoot: string;
  private readonly handle: CodexNotificationOutboxOptions['handle'];
  private readonly intervalMs: number;
  private timer: Timer | null = null;
  private drainPromise: Promise<void> | null = null;

  constructor(options: CodexNotificationOutboxOptions) {
    this.dataRoot = options.dataRoot;
    this.handle = options.handle;
    this.intervalMs = options.intervalMs ?? 500;
  }

  async start(): Promise<void> {
    if (this.timer) return;
    await this.drain();
    this.timer = setInterval(() => { void this.drain(); }, this.intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.drainPromise;
  }

  private async drain(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    const operation = this.drainInternal();
    this.drainPromise = operation;
    try {
      await operation;
    } finally {
      if (this.drainPromise === operation) this.drainPromise = null;
    }
  }

  private async drainInternal(): Promise<void> {
    const items = await listOutboxEvents(this.dataRoot);
    for (const item of items) {
      try {
        const result = await this.handle(item.event);
        if (result !== 'failed') await removeOutboxEvent(item.path);
      } catch {
        // Keep the file for the next drain cycle.
      }
    }
  }
}
