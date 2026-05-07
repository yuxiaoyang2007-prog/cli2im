export class RateLimiter {
  private buckets = new Map<string, number[]>();
  private maxTokens: number;
  private windowMs: number;

  constructor(maxTokens: number, windowMs: number) {
    this.maxTokens = maxTokens;
    this.windowMs = windowMs;
  }

  check(chatId: string): boolean {
    const now = Date.now();
    const timestamps = this.buckets.get(chatId) ?? [];
    const valid = timestamps.filter((t) => now - t < this.windowMs);

    if (valid.length >= this.maxTokens) {
      this.buckets.set(chatId, valid);
      return false;
    }

    valid.push(now);
    this.buckets.set(chatId, valid);
    return true;
  }
}
