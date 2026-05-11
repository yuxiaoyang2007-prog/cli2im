import { describe, it, expect } from 'vitest';
import {
  InboundPipeline,
  getGroupMessageSkipReason,
  buildSenderHeader,
} from '../src/pipeline.js';
import type { AppConfig, BotConfig, InboundMessage, SenderInfo } from '../src/types.js';
import { RelayManager } from '../src/relay/manager.js';

const baseConfig: AppConfig = {
  bots: {
    ccbot: {
      agent: 'claude-code',
      platform: 'feishu',
      feishu: { appId: 'cli_abc', appSecret: 'secret' },
      workingDirectory: '/tmp/test',
      allowFrom: ['ou_allowed'],
      permissionMode: 'blacklist',
      requireMention: true,
      relay: { enabled: true, maxConsecutiveRounds: 5 },
    },
    codexbot: {
      agent: 'codex',
      platform: 'feishu',
      feishu: { appId: 'cli_def', appSecret: 'secret2' },
      workingDirectory: '/tmp/test',
      allowFrom: ['ou_allowed'],
      permissionMode: 'blacklist',
      requireMention: true,
      relay: { enabled: true, maxConsecutiveRounds: 5 },
    },
  },
  agents: {
    'claude-code': { binary: '/usr/local/bin/claude' },
    codex: { binary: '/usr/local/bin/codex' },
  },
  session: { maxActive: 64, idleResetMinutes: 120, dbPath: ':memory:' },
  dangerousPatterns: [],
  streaming: { intervalMs: 200, minDeltaChars: 30, highWaterMark: 1048576 },
  server: { port: 3900, host: '127.0.0.1', token: 'token' },
  newMessageBehavior: 'queue',
};

function relayMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: 'feishu',
    chatId: 'chat_group',
    userId: 'relay:ccbot',
    userName: 'Claude Code',
    text: 'Here is my code review...',
    chatType: 'group',
    isRelay: true,
    ...overrides,
  };
}

function humanMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: 'feishu',
    chatId: 'chat_group',
    userId: 'ou_allowed',
    userName: 'Test User',
    text: 'hello',
    chatType: 'group',
    ...overrides,
  };
}

describe('Relay sender header', () => {
  it('includes channel="relay" and bot attribute', () => {
    const sender: SenderInfo = {
      channel: 'relay',
      userId: 'relay:ccbot',
      botName: 'ccbot',
      userName: 'Claude Code',
    };
    const header = buildSenderHeader(sender);

    expect(header).toContain('channel="relay"');
    expect(header).toContain('bot="ccbot"');
    expect(header).toContain('name="Claude Code"');
    expect(header).toMatch(/^<cti-sender /);
  });

  it('omits bot attribute for non-relay messages', () => {
    const sender: SenderInfo = {
      channel: 'feishu',
      userId: 'ou_user',
      userName: 'Human',
    };
    const header = buildSenderHeader(sender);

    expect(header).not.toContain('bot=');
    expect(header).toContain('channel="feishu"');
  });
});

describe('Relay messages bypass allowFrom', () => {
  it('relay messages pass pipeline even from unauthorized user', () => {
    const pipeline = new InboundPipeline(baseConfig);
    const msg = relayMsg({ chatType: 'p2p', userId: 'relay:ccbot' });
    const result = pipeline.process(msg, 'codexbot');

    // isRelay bypasses the allowFrom check
    expect('rejected' in result).toBe(false);
  });

  it('non-relay messages from unauthorized user are still rejected', () => {
    const pipeline = new InboundPipeline(baseConfig);
    const msg = humanMsg({ chatType: 'p2p', userId: 'ou_unauthorized' });
    const result = pipeline.process(msg, 'codexbot');

    expect(result).toEqual({ rejected: true, reason: 'Unauthorized user' });
  });
});

describe('Relay messages bypass requireMention', () => {
  it('relay messages skip group mention check', () => {
    const botConfig: BotConfig = {
      ...baseConfig.bots.codexbot,
      requireMention: true,
    };
    const msg = relayMsg({ mentions: [] });

    const reason = getGroupMessageSkipReason(msg, botConfig, 'ou_bot');
    expect(reason).toBeUndefined();
  });

  it('non-relay messages without mention are rejected', () => {
    const botConfig: BotConfig = {
      ...baseConfig.bots.codexbot,
      requireMention: true,
    };
    const msg = humanMsg({ mentions: [] });

    const reason = getGroupMessageSkipReason(msg, botConfig, 'ou_bot');
    expect(reason).toBe('Bot mention required');
  });
});

describe('Relay-enabled bots implicitly require mention', () => {
  it('requires mention when 2+ relay bots in chat', () => {
    const botConfig: BotConfig = {
      ...baseConfig.bots.codexbot,
      requireMention: false,
      relay: { enabled: true, maxConsecutiveRounds: 5 },
    };
    const msg = humanMsg({ mentions: [] });

    const reason = getGroupMessageSkipReason(msg, botConfig, 'ou_bot', 2);
    expect(reason).toBe('Bot mention required');
  });

  it('does not require mention when only 1 relay bot in chat', () => {
    const botConfig: BotConfig = {
      ...baseConfig.bots.codexbot,
      requireMention: false,
      relay: { enabled: true, maxConsecutiveRounds: 5 },
    };
    const msg = humanMsg({ mentions: [] });

    const reason = getGroupMessageSkipReason(msg, botConfig, 'ou_bot', 1);
    expect(reason).toBeUndefined();
  });

  it('relay message bypasses implicit mention even with 2+ bots', () => {
    const botConfig: BotConfig = {
      ...baseConfig.bots.codexbot,
      requireMention: false,
      relay: { enabled: true, maxConsecutiveRounds: 5 },
    };
    const msg = relayMsg({ mentions: [] });

    const reason = getGroupMessageSkipReason(msg, botConfig, 'ou_bot', 3);
    expect(reason).toBeUndefined();
  });
});

describe('Relay messages skip sanitizeInput', () => {
  it('relay message text is not modified by pipeline', () => {
    const pipeline = new InboundPipeline(baseConfig);
    const originalText = 'Here is my code review with <special> chars & "quotes"';
    const msg = relayMsg({ text: originalText, chatType: 'group' });
    const result = pipeline.process(msg, 'codexbot');

    // Pipeline should not have modified the text (sanitizeInput skipped)
    expect('rejected' in result).toBe(false);
    if (!('rejected' in result)) {
      expect(result.message.text).toBe(originalText);
    }
  });
});

describe('Relay messages remain rate limited', () => {
  it('rejects relay messages beyond the per-chat rate-limit capacity', () => {
    const pipeline = new InboundPipeline(baseConfig);

    for (let i = 0; i < 20; i++) {
      const result = pipeline.process(relayMsg({ text: `relay output ${i}` }), 'codexbot');
      expect('rejected' in result).toBe(false);
    }

    const result = pipeline.process(relayMsg({ text: 'relay output over capacity' }), 'codexbot');
    expect(result).toEqual({ rejected: true, reason: 'Rate limited' });
  });

  it('tracks relay rate limits per chat', () => {
    const pipeline = new InboundPipeline(baseConfig);

    for (let i = 0; i < 20; i++) {
      const result = pipeline.process(relayMsg({ text: `relay output ${i}` }), 'codexbot');
      expect('rejected' in result).toBe(false);
    }

    const otherChatResult = pipeline.process(
      relayMsg({ chatId: 'chat_other_group', text: 'relay output in another chat' }),
      'codexbot',
    );
    expect('rejected' in otherChatResult).toBe(false);
  });
});

describe('Round limit triggers single pause notification', () => {
  it('getRelayTargets returns empty after limit reached', () => {
    const rm = new RelayManager();
    rm.registerBot('ccbot', 'chat_1', 2);
    rm.registerBot('codexbot', 'chat_1', 2);

    // Simulate 2 relay rounds
    rm.incrementAndCheck('chat_1'); // 1
    rm.incrementAndCheck('chat_1'); // 2 = limit

    // Targets should now be empty
    expect(rm.getRelayTargets('ccbot', 'chat_1')).toEqual([]);
  });
});

describe('Human message resets counter', () => {
  it('resets relay round counter on human message', () => {
    const rm = new RelayManager();
    rm.registerBot('ccbot', 'chat_1', 2);
    rm.registerBot('codexbot', 'chat_1', 2);

    rm.incrementAndCheck('chat_1'); // 1
    rm.incrementAndCheck('chat_1'); // 2 = limit
    expect(rm.getRelayTargets('ccbot', 'chat_1')).toEqual([]);

    rm.onHumanMessage('chat_1'); // reset
    expect(rm.getRelayTargets('ccbot', 'chat_1')).toEqual(['codexbot']);
  });
});

describe('No relay when only one bot has relay enabled', () => {
  it('single relay bot gets no targets', () => {
    const rm = new RelayManager();
    rm.registerBot('ccbot', 'chat_1', 10);
    // codexbot not registered (relay not enabled or hasn't sent a message)

    expect(rm.getRelayTargets('ccbot', 'chat_1')).toEqual([]);
  });
});

describe('Group allowlist bypass for relay', () => {
  it('relay messages bypass group allowlist', () => {
    const botConfig: BotConfig = {
      ...baseConfig.bots.codexbot,
      groupPolicy: 'allowlist',
      groupAllowFrom: ['oc_specific_group'],
    };
    // Relay message from a different group
    const msg = relayMsg({ chatId: 'oc_other_group' });

    const reason = getGroupMessageSkipReason(msg, botConfig, 'ou_bot');
    expect(reason).toBeUndefined();
  });
});
