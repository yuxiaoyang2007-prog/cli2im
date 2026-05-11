interface RelayGroup {
  botNames: Set<string>;
  consecutiveRounds: number;
  maxRounds: number;
}

export class RelayManager {
  private groups = new Map<string, RelayGroup>();

  /**
   * Lazy registration: called on first message from a relay-enabled bot in a group.
   * If botName is already registered for this chatId, this is a no-op.
   * Updates maxRounds to min(existing, newBot's maxRounds).
   */
  registerBot(botName: string, chatId: string, maxRounds: number): void {
    const group = this.groups.get(chatId);
    if (group) {
      if (group.botNames.has(botName)) return;
      group.botNames.add(botName);
      group.maxRounds = Math.min(group.maxRounds, maxRounds);
    } else {
      this.groups.set(chatId, {
        botNames: new Set([botName]),
        consecutiveRounds: 0,
        maxRounds,
      });
    }
  }

  /**
   * Returns list of bot names to relay to.
   * Returns empty if: only one bot, source not registered, or rounds exceeded.
   */
  getRelayTargets(sourceBotName: string, chatId: string): string[] {
    const group = this.groups.get(chatId);
    if (!group) return [];
    if (!group.botNames.has(sourceBotName)) return [];
    if (group.botNames.size < 2) return [];
    if (group.consecutiveRounds >= group.maxRounds) return [];
    return [...group.botNames].filter((name) => name !== sourceBotName);
  }

  /**
   * Returns all relay-enabled bots in a chat (for pause notifications).
   */
  getBotsInChat(chatId: string): string[] {
    const group = this.groups.get(chatId);
    return group ? [...group.botNames] : [];
  }

  /**
   * Called on every human message in the group. Resets counter.
   */
  onHumanMessage(chatId: string): void {
    const group = this.groups.get(chatId);
    if (group) {
      group.consecutiveRounds = 0;
    }
  }

  /**
   * Increments counter. Returns true if limit NOW reached.
   */
  incrementAndCheck(chatId: string): boolean {
    const group = this.groups.get(chatId);
    if (!group) return false;
    group.consecutiveRounds++;
    return group.consecutiveRounds >= group.maxRounds;
  }
}
