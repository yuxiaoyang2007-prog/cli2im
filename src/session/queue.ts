export class ChatQueue {
  private queues = new Map<string, Promise<void>>();

  async enqueue(chatId: string, task: () => Promise<void>): Promise<void> {
    const prev = this.queues.get(chatId) ?? Promise.resolve();
    const next = prev.then(task, task);
    this.queues.set(chatId, next.catch(() => {}));
    return next;
  }
}
