import { QueueCancelledError } from '../session/queue.js';

/** Stops an earlier async download/setup from launching work after cancellation. */
export class PreparationGuard {
  private generations = new Map<string, number>();

  capture(key: string): () => void {
    const generation = this.generations.get(key) ?? 0;
    this.generations.set(key, generation);
    return () => {
      if (this.generations.get(key) !== generation) throw new QueueCancelledError();
    };
  }

  cancel(key: string): void {
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
  }

  cancelBot(botName: string): void {
    for (const key of this.generations.keys()) {
      if (key.split(':')[2] === botName) this.cancel(key);
    }
  }
}
