type PendingNext<T> = (result: IteratorResult<T>) => void;

export class InputQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private pending: PendingNext<T>[] = [];
  private closed = false;

  push(item: T): boolean {
    if (this.closed) return false;

    const resolve = this.pending.shift();
    if (resolve) {
      resolve({ value: item, done: false });
      return false;
    }

    this.items.push(item);
    return true;
  }

  close(): void {
    if (this.closed) return;

    this.closed = true;
    for (const resolve of this.pending.splice(0)) {
      resolve({ value: undefined, done: true });
    }
  }

  drain(): T[] {
    return this.items.splice(0);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => this.next(),
      return: async () => {
        this.close();
        return { value: undefined, done: true };
      },
    };
  }

  private next(): Promise<IteratorResult<T>> {
    const item = this.items.shift();
    if (item !== undefined) {
      return Promise.resolve({ value: item, done: false });
    }

    if (this.closed) {
      return Promise.resolve({ value: undefined, done: true });
    }

    return new Promise((resolve) => {
      this.pending.push(resolve);
    });
  }
}
