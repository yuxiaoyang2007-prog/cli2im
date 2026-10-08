interface TaskTicket {
  owner?: AbortSignal;
  onAbort?: () => void;
}

interface ScopeTasks {
  pending: Set<TaskTicket>;
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

  begin(key: string): { dispatch(owner: AbortSignal): void } {
    const scope = this.get(key);
    const task: TaskTicket = {};
    scope.pending.add(task);
    scope.revision++;
    // Preparation has no process owner. Cancellation cannot revive this ticket.
    return {
      dispatch: owner => {
        if (!scope.pending.has(task) || task.owner) return;
        task.owner = owner;
        // A replaced process may never reach its current-context exit callback.
        task.onAbort = () => this.remove(scope, task);
        owner.addEventListener('abort', task.onAbort, { once: true });
        if (owner.aborted) this.remove(scope, task);
      },
    };
  }

  /** A process exit cancels only dispatched turns; explicit stop cancels all. */
  cancel(key: string, owner?: AbortSignal): TaskCompletion {
    const scope = this.get(key);
    for (const task of scope.pending) {
      if (!owner || task.owner === owner) this.remove(scope, task);
    }
    return this.completion(scope);
  }

  /** Claim the oldest accepted turn synchronously, before awaiting delivery or disk. */
  finish(key: string, owner?: AbortSignal): TaskCompletion {
    const scope = this.get(key);
    for (const task of scope.pending) {
      if (!owner || task.owner === owner) {
        this.remove(scope, task);
        break;
      }
    }
    return this.completion(scope);
  }

  private remove(scope: ScopeTasks, task: TaskTicket): void {
    if (!scope.pending.delete(task)) return;
    if (task.onAbort) {
      task.owner?.removeEventListener('abort', task.onAbort);
      task.onAbort = undefined;
    }
    scope.revision++;
  }

  private completion(scope: ScopeTasks): TaskCompletion {
    const revision = ++scope.revision;
    return {
      remaining: scope.pending.size,
      isCurrent: () => scope.revision === revision,
    };
  }

  size(): number {
    return this.keys().length;
  }

  keys(): string[] {
    return [...this.scopes].filter(([, scope]) => scope.pending.size > 0).map(([key]) => key);
  }

  private get(key: string): ScopeTasks {
    let scope = this.scopes.get(key);
    if (!scope) {
      scope = { pending: new Set(), revision: 0 };
      this.scopes.set(key, scope);
    }
    // Keep zero-count revisions so an older completion never becomes current again.
    return scope;
  }
}
