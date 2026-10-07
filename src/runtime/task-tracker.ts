interface ScopeTasks {
  pending: number;
  revision: number;
}

export interface TaskCompletion {
  remaining: number;
  /** False after any subsequent begin, finish, or cancel for this scope. */
  isCurrent(): boolean;
}

/** Tracks accepted turns, not persistent agent processes or connected adapters. */
export class TaskTracker {
  private scopes = new Map<string, ScopeTasks>();

  begin(key: string): void {
    const scope = this.get(key);
    scope.pending++;
    scope.revision++;
  }

  cancel(key: string): void {
    const scope = this.get(key);
    scope.pending = 0;
    scope.revision++;
  }

  /** Claim the oldest accepted turn synchronously, before awaiting delivery or disk. */
  finish(key: string): TaskCompletion {
    const scope = this.get(key);
    scope.pending = Math.max(0, scope.pending - 1);
    const revision = ++scope.revision;
    return {
      remaining: scope.pending,
      isCurrent: () => scope.revision === revision,
    };
  }

  size(): number {
    return this.keys().length;
  }

  keys(): string[] {
    return [...this.scopes].filter(([, scope]) => scope.pending > 0).map(([key]) => key);
  }

  private get(key: string): ScopeTasks {
    let scope = this.scopes.get(key);
    if (!scope) {
      scope = { pending: 0, revision: 0 };
      this.scopes.set(key, scope);
    }
    // Keep zero-count revisions so an older completion never becomes current again.
    return scope;
  }
}
