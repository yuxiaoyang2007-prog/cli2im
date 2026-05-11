export class RateLimiter {
  private chatBuckets = new Map<string, number[]>();
  private userBuckets = new Map<string, number[]>();
  private maxTokens: number;
  private userMaxTokens: number;
  private windowMs: number;

  constructor(maxTokens: number, windowMs: number, userMaxTokens = 30) {
    this.maxTokens = maxTokens;
    this.userMaxTokens = userMaxTokens;
    this.windowMs = windowMs;
  }

  check(chatId: string, userId?: string): boolean {
    const now = Date.now();
    const chatTimestamps = this.prune(this.chatBuckets.get(chatId) ?? [], now);
    const userTimestamps = userId
      ? this.prune(this.userBuckets.get(userId) ?? [], now)
      : undefined;

    if (chatTimestamps.length >= this.maxTokens) {
      this.chatBuckets.set(chatId, chatTimestamps);
      if (userId && userTimestamps) this.userBuckets.set(userId, userTimestamps);
      return false;
    }
    if (userId && userTimestamps && userTimestamps.length >= this.userMaxTokens) {
      this.chatBuckets.set(chatId, chatTimestamps);
      this.userBuckets.set(userId, userTimestamps);
      return false;
    }

    chatTimestamps.push(now);
    this.chatBuckets.set(chatId, chatTimestamps);
    if (userId && userTimestamps) {
      userTimestamps.push(now);
      this.userBuckets.set(userId, userTimestamps);
    }
    return true;
  }

  private prune(timestamps: number[], now: number): number[] {
    return timestamps.filter((t) => now - t < this.windowMs);
  }
}
