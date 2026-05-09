import { describe, it, expect } from 'vitest';
import { RelayManager } from '../src/relay/manager.js';

describe('RelayManager', () => {
  it('returns correct targets (excludes source bot)', () => {
    const rm = new RelayManager();
    rm.registerBot('ccbot', 'chat_1', 10);
    rm.registerBot('codexbot', 'chat_1', 10);

    const targets = rm.getRelayTargets('ccbot', 'chat_1');
    expect(targets).toEqual(['codexbot']);
  });

  it('returns empty when only one relay bot in chat', () => {
    const rm = new RelayManager();
    rm.registerBot('ccbot', 'chat_1', 10);

    expect(rm.getRelayTargets('ccbot', 'chat_1')).toEqual([]);
  });

  it('returns empty for unregistered bot', () => {
    const rm = new RelayManager();
    rm.registerBot('ccbot', 'chat_1', 10);
    rm.registerBot('codexbot', 'chat_1', 10);

    expect(rm.getRelayTargets('unknown', 'chat_1')).toEqual([]);
  });

  it('returns empty for unregistered chatId', () => {
    const rm = new RelayManager();
    expect(rm.getRelayTargets('ccbot', 'chat_unknown')).toEqual([]);
  });

  it('counter increments and pauses at limit', () => {
    const rm = new RelayManager();
    rm.registerBot('ccbot', 'chat_1', 3);
    rm.registerBot('codexbot', 'chat_1', 3);

    expect(rm.incrementAndCheck('chat_1')).toBe(false); // 1
    expect(rm.incrementAndCheck('chat_1')).toBe(false); // 2
    expect(rm.incrementAndCheck('chat_1')).toBe(true);  // 3 = limit reached

    // After limit reached, getRelayTargets returns empty
    expect(rm.getRelayTargets('ccbot', 'chat_1')).toEqual([]);
  });

  it('counter uses min() of all bots maxRounds', () => {
    const rm = new RelayManager();
    rm.registerBot('ccbot', 'chat_1', 10);
    rm.registerBot('codexbot', 'chat_1', 3);

    // maxRounds should be min(10, 3) = 3
    expect(rm.incrementAndCheck('chat_1')).toBe(false); // 1
    expect(rm.incrementAndCheck('chat_1')).toBe(false); // 2
    expect(rm.incrementAndCheck('chat_1')).toBe(true);  // 3 = limit
  });

  it('onHumanMessage resets counter', () => {
    const rm = new RelayManager();
    rm.registerBot('ccbot', 'chat_1', 3);
    rm.registerBot('codexbot', 'chat_1', 3);

    rm.incrementAndCheck('chat_1'); // 1
    rm.incrementAndCheck('chat_1'); // 2
    rm.onHumanMessage('chat_1');    // reset to 0

    expect(rm.incrementAndCheck('chat_1')).toBe(false); // 1
    expect(rm.incrementAndCheck('chat_1')).toBe(false); // 2
    expect(rm.incrementAndCheck('chat_1')).toBe(true);  // 3 = limit
  });

  it('multiple chats tracked independently', () => {
    const rm = new RelayManager();
    rm.registerBot('ccbot', 'chat_1', 10);
    rm.registerBot('codexbot', 'chat_1', 10);
    rm.registerBot('ccbot', 'chat_2', 2);
    rm.registerBot('codexbot', 'chat_2', 2);

    rm.incrementAndCheck('chat_2'); // chat_2: 1
    rm.incrementAndCheck('chat_2'); // chat_2: 2 = limit

    // chat_1 should be unaffected
    expect(rm.getRelayTargets('ccbot', 'chat_1')).toEqual(['codexbot']);
    // chat_2 should be blocked
    expect(rm.getRelayTargets('ccbot', 'chat_2')).toEqual([]);
  });

  it('registerBot is idempotent for same bot+chatId', () => {
    const rm = new RelayManager();
    rm.registerBot('ccbot', 'chat_1', 10);
    rm.registerBot('ccbot', 'chat_1', 5); // idempotent — should not update maxRounds
    rm.registerBot('codexbot', 'chat_1', 8);

    // maxRounds = min(10, 8) = 8 (the second registerBot('ccbot', ..., 5) was a no-op)
    const targets = rm.getRelayTargets('ccbot', 'chat_1');
    expect(targets).toEqual(['codexbot']);

    // Verify the maxRounds by counting increments
    for (let i = 0; i < 7; i++) {
      expect(rm.incrementAndCheck('chat_1')).toBe(false);
    }
    expect(rm.incrementAndCheck('chat_1')).toBe(true); // 8 = limit
  });

  it('getBotsInChat returns all registered bots', () => {
    const rm = new RelayManager();
    rm.registerBot('ccbot', 'chat_1', 10);
    rm.registerBot('codexbot', 'chat_1', 10);
    rm.registerBot('geminibot', 'chat_1', 10);

    const bots = rm.getBotsInChat('chat_1');
    expect(bots).toHaveLength(3);
    expect(bots).toContain('ccbot');
    expect(bots).toContain('codexbot');
    expect(bots).toContain('geminibot');
  });

  it('getBotsInChat returns empty for unknown chat', () => {
    const rm = new RelayManager();
    expect(rm.getBotsInChat('unknown')).toEqual([]);
  });

  it('onHumanMessage is safe for unknown chatId', () => {
    const rm = new RelayManager();
    // Should not throw
    rm.onHumanMessage('unknown');
  });

  it('incrementAndCheck returns false for unknown chatId', () => {
    const rm = new RelayManager();
    expect(rm.incrementAndCheck('unknown')).toBe(false);
  });

  it('handles three bots — returns all others as targets', () => {
    const rm = new RelayManager();
    rm.registerBot('a', 'chat_1', 10);
    rm.registerBot('b', 'chat_1', 10);
    rm.registerBot('c', 'chat_1', 10);

    const targets = rm.getRelayTargets('a', 'chat_1');
    expect(targets).toEqual(expect.arrayContaining(['b', 'c']));
    expect(targets).toHaveLength(2);
  });
});
