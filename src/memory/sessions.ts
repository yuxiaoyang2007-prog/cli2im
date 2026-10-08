import type { SessionKey } from '../types.js';
import type { SessionStore } from '../session/store.js';
import { QueueCancelledError } from '../session/queue.js';
import type { MemoryStore } from './store.js';

/** Current chat bindings only. Historical agent-session provenance is stored separately. */
export class MemorySessions {
  private principals = new Map<SessionKey, string>();
  private epochs = new Map<string, number>();
  private revoking = new Map<string, number>();
  constructor(private store: SessionStore, private memory: MemoryStore,
    private invalidate: (key: SessionKey) => void) {}

  track(key: SessionKey, principal: string): void {
    if (this.revoking.has(principal)) throw new QueueCancelledError();
    this.principals.set(key, principal);
  }

  async bind(key: SessionKey, principal: string): Promise<boolean> {
    const epoch = this.epochs.get(principal) ?? 0;
    const check = () => {
      if (this.revoking.has(principal) || (this.epochs.get(principal) ?? 0) !== epoch) throw new QueueCancelledError();
    };
    check();
    this.track(key, principal);
    const generation = await this.memory.generation(principal);
    const previous = await this.store.getPreferences(key);
    check();
    const reset = previous.memoryPrincipal !== undefined
      && (previous.memoryPrincipal !== principal || previous.memoryGeneration !== generation);
    if (reset) {
      await this.clear(key);
    }
    check();
    if (previous.memoryPrincipal !== principal || previous.memoryGeneration !== generation) {
      await this.store.updatePreferences(key, { memoryPrincipal: principal, memoryGeneration: generation });
    }
    check();
    return reset;
  }

  async revoke(principal: string): Promise<void> {
    this.epochs.set(principal, (this.epochs.get(principal) ?? 0) + 1);
    this.revoking.set(principal, (this.revoking.get(principal) ?? 0) + 1);
    try {
      // Cancel live preparations before any database await; include batched messages bound at admission.
      const keys = new Set<SessionKey>();
      for (const [key, bound] of this.principals) if (bound === principal) keys.add(key);
      for (const key of keys) this.invalidate(key);
      for (const key of await this.store.memorySessionKeys(principal)) keys.add(key);
      for (const key of keys) await this.clear(key);
    } finally {
      const remaining = this.revoking.get(principal)! - 1;
      if (remaining) this.revoking.set(principal, remaining);
      else this.revoking.delete(principal);
    }
  }

  private async clear(key: SessionKey): Promise<void> {
    this.invalidate(key);
    const session = await this.store.getByKey(key);
    if (session) await this.store.clearAgentSessionId(session.id);
    await this.store.updatePreferences(key, { taskState: undefined });
  }
}
