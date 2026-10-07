import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/security/validators.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/security/validators.js')>();
  return {
    ...actual,
    sanitizeInput: vi.fn(actual.sanitizeInput),
  };
});

import * as validators from '../src/security/validators.js';
import {
  InboundPipeline,
  getGroupMessageSkipReason,
  parseBridgeCommand,
  isBridgeCommand,
} from '../src/pipeline.js';
import type { AppConfig, InboundMessage } from '../src/types.js';

describe('isBridgeCommand', () => {
  it('recognizes bridge commands', () => {
    expect(isBridgeCommand('/new')).toBe(true);
    expect(isBridgeCommand('/list')).toBe(true);
    expect(isBridgeCommand('/switch abc')).toBe(true);
    expect(isBridgeCommand('/cwd ~/projects')).toBe(true);
    expect(isBridgeCommand('/status')).toBe(true);
    expect(isBridgeCommand('/stop')).toBe(true);
    expect(isBridgeCommand('/kill')).toBe(true);
    expect(isBridgeCommand('/resume ses_abc')).toBe(true);
    expect(isBridgeCommand('/handoff')).toBe(true);
    expect(isBridgeCommand('/force-approve')).toBe(true);
    expect(isBridgeCommand('/model opus')).toBe(true);
    expect(isBridgeCommand('/clear')).toBe(true);
    expect(isBridgeCommand('/thinking')).toBe(true);
    expect(isBridgeCommand('/fast')).toBe(true);
    expect(isBridgeCommand('/perm allow req_123')).toBe(true);
    expect(isBridgeCommand('/sessions')).toBe(true);
    expect(isBridgeCommand('/notify-me')).toBe(true);
    expect(isBridgeCommand('/help')).toBe(true);
    expect(isBridgeCommand('/projects')).toBe(true);
    expect(isBridgeCommand('/cd demo')).toBe(true);
    expect(isBridgeCommand('/task review')).toBe(true);
    expect(isBridgeCommand('/doctor')).toBe(true);
    expect(isBridgeCommand('/bots')).toBe(true);
    expect(isBridgeCommand('/result')).toBe(true);
  });

  it('does not recognize CLI passthrough commands', () => {
    expect(isBridgeCommand('/compact')).toBe(false);
    expect(isBridgeCommand('/review')).toBe(false);
    expect(isBridgeCommand('/cost')).toBe(false);
  });

  it('does not recognize plain messages', () => {
    expect(isBridgeCommand('hello')).toBe(false);
    expect(isBridgeCommand('help me fix this')).toBe(false);
  });
});

describe('parseBridgeCommand', () => {
  it('parses /new', () => {
    const cmd = parseBridgeCommand('/new');
    expect(cmd).toEqual({ command: 'new', args: [] });
  });

  it('parses /clear as a bridge reset command', () => {
    const cmd = parseBridgeCommand('/clear');
    expect(cmd).toEqual({ command: 'new', args: [] });
  });

  it('parses /switch with args', () => {
    const cmd = parseBridgeCommand('/switch ses_abc123');
    expect(cmd).toEqual({ command: 'switch', args: ['ses_abc123'] });
  });

  it('parses /cwd with path', () => {
    const cmd = parseBridgeCommand('/cwd ~/projects/newsradar');
    expect(cmd).toEqual({ command: 'cwd', args: ['~/projects/newsradar'] });
  });

  it('parses /cd as a project switch alias', () => {
    expect(parseBridgeCommand('/cd demo')).toEqual({ command: 'cwd', args: ['demo'] });
  });

  it('parses /model with name', () => {
    const cmd = parseBridgeCommand('/model claude-sonnet-4-20250514');
    expect(cmd).toEqual({ command: 'model', args: ['claude-sonnet-4-20250514'] });
  });

  it('parses /perm with decision and request id', () => {
    const cmd = parseBridgeCommand('/perm allow req_123');
    expect(cmd).toEqual({ command: 'perm', args: ['allow', 'req_123'] });
  });

  it('parses /notify-me', () => {
    expect(parseBridgeCommand('/notify-me')).toEqual({ command: 'notify-me', args: [] });
  });

  it('returns null for non-bridge commands', () => {
    expect(parseBridgeCommand('/compact')).toBeNull();
    expect(parseBridgeCommand('hello')).toBeNull();
  });
});

describe('InboundPipeline authorization', () => {
  const config: AppConfig = {
    bots: {
      ccbot: {
        agent: 'claude-code',
        platform: 'feishu',
        feishu: { appId: 'cli_abc', appSecret: 'secret' },
        workingDirectory: '/Users/test/project',
        allowFrom: ['ou_allowed'],
        permissionMode: 'blacklist',
      },
    },
    agents: {
      'claude-code': { binary: '/usr/local/bin/claude' },
    },
    session: {
      maxActive: 64,
      idleResetMinutes: 120,
      dbPath: ':memory:',
    },
    dangerousPatterns: [],
    streaming: {
      intervalMs: 200,
      minDeltaChars: 30,
      highWaterMark: 1048576,
    },
    server: {
      port: 3900,
      host: '127.0.0.1',
      token: 'token',
    },
    newMessageBehavior: 'queue',
  };

  function message(overrides: Partial<InboundMessage>): InboundMessage {
    return {
      platform: 'feishu',
      chatId: 'chat_1',
      userId: 'ou_unknown',
      text: 'hello',
      ...overrides,
    };
  }

  it('rejects unauthorized direct messages', () => {
    const pipeline = new InboundPipeline(config);
    const result = pipeline.process(message({ chatType: 'p2p' }), 'ccbot');

    expect(result).toEqual({ rejected: true, reason: 'Unauthorized user' });
  });

  it('rejects unauthorized users before sanitizing pathological cti payloads', () => {
    const sanitizeInput = vi.mocked(validators.sanitizeInput);
    sanitizeInput.mockClear();
    const pipeline = new InboundPipeline(config);
    const result = pipeline.process(message({
      chatType: 'p2p',
      text: '< c t i - s e n d e r '.repeat(2500),
    }), 'ccbot');

    expect(result).toEqual({ rejected: true, reason: 'Unauthorized user' });
    expect(sanitizeInput).not.toHaveBeenCalled();
  });

  it('rejects unauthorized group messages', () => {
    const pipeline = new InboundPipeline(config);
    const result = pipeline.process(message({ chatType: 'group' }), 'ccbot');

    expect(result).toEqual({ rejected: true, reason: 'Unauthorized user' });
  });

  it('allows authorized group messages', () => {
    const pipeline = new InboundPipeline(config);
    const result = pipeline.process(message({ chatType: 'group', userId: 'ou_allowed' }), 'ccbot');

    expect('rejected' in result).toBe(false);
  });

  it.each([{ allowFrom: [] }, { allowFrom: ['*'] }])('denies implicit public access %j', (override) => {
    const pipeline = new InboundPipeline({ ...config, bots: { ccbot: { ...config.bots.ccbot, ...override } } });
    expect(pipeline.process(message({}), 'ccbot')).toEqual({ rejected: true, reason: 'Unauthorized user' });
  });

  it('applies group restrictions in pipeline itself, including Telegram supergroups', () => {
    const pipeline = new InboundPipeline({ ...config, bots: { ccbot: { ...config.bots.ccbot, groupAllowFrom: ['allowed_group'] } } });
    expect(pipeline.process(message({ userId: 'ou_allowed', chatType: 'supergroup' }), 'ccbot')).toEqual({ rejected: true, reason: 'Unauthorized group' });
  });

  it('separates two topics inside one chat', () => {
    const pipeline = new InboundPipeline(config);
    const first = pipeline.process(message({ userId: 'ou_allowed', threadId: 'topic_1' }), 'ccbot');
    const second = pipeline.process(message({ userId: 'ou_allowed', threadId: 'topic_2' }), 'ccbot');
    expect('sessionKey' in first && first.sessionKey).toBe('feishu:chat_1:ccbot:topic_1');
    expect('sessionKey' in second && second.sessionKey).toBe('feishu:chat_1:ccbot:topic_2');
  });

  it('denies a relay flag without an explicitly granted source', () => {
    const pipeline = new InboundPipeline(config);
    expect(pipeline.process(message({ userId: 'relay:other', chatType: 'group', isRelay: true }), 'ccbot'))
      .toEqual({ rejected: true, reason: 'Unauthorized relay' });
  });

  it('rejects rate-limited users before sanitizing inbound text', () => {
    const sanitizeInput = vi.mocked(validators.sanitizeInput);
    sanitizeInput.mockClear();
    const pipeline = new InboundPipeline(config);

    for (let i = 0; i < 20; i++) {
      const result = pipeline.process(message({
        chatType: 'p2p',
        userId: 'ou_allowed',
        text: `hello ${i}`,
      }), 'ccbot');
      expect('rejected' in result).toBe(false);
    }

    sanitizeInput.mockClear();
    const result = pipeline.process(message({
      chatType: 'p2p',
      userId: 'ou_allowed',
      text: '< c t i - s e n d e r '.repeat(2500),
    }), 'ccbot');

    expect(result).toEqual({ rejected: true, reason: 'Rate limited' });
    expect(sanitizeInput).not.toHaveBeenCalled();
  });

  it('rejects messages with empty userId even when allowFrom contains wildcard', () => {
    const wildcardConfig: AppConfig = {
      ...config,
      bots: {
        ccbot: {
          ...config.bots.ccbot,
          allowFrom: ['*'],
        },
      },
    };
    const pipeline = new InboundPipeline(wildcardConfig);
    const result = pipeline.process(message({ chatType: 'p2p', userId: '' }), 'ccbot');

    expect(result).toEqual({ rejected: true, reason: 'Missing user id' });
  });

  it('requires group allowlist to match chat id', () => {
    const botConfig = {
      ...config.bots.ccbot,
      groupPolicy: 'allowlist' as const,
      groupAllowFrom: ['oc_allowed'],
    };

    expect(getGroupMessageSkipReason(message({
      chatType: 'group',
      chatId: 'oc_blocked',
      userId: 'oc_allowed',
    }), botConfig, 'ou_bot')).toBe('Unauthorized group');
    expect(getGroupMessageSkipReason(message({
      chatType: 'group',
      chatId: 'oc_allowed',
      userId: 'ou_other',
    }), botConfig, 'ou_bot')).toBeUndefined();
  });

  it('requires bot mention in groups including bridge commands', () => {
    const botConfig = {
      ...config.bots.ccbot,
      requireMention: true,
    };

    expect(getGroupMessageSkipReason(message({
      chatType: 'group',
      text: 'hello',
      mentions: ['ou_other'],
    }), botConfig, 'ou_bot')).toBe('Bot mention required');
    expect(getGroupMessageSkipReason(message({
      chatType: 'group',
      text: 'hello',
      mentions: ['ou_bot'],
    }), botConfig, 'ou_bot')).toBeUndefined();
    expect(getGroupMessageSkipReason(message({
      chatType: 'group',
      text: '/kill',
      mentions: [],
    }), botConfig, 'ou_bot')).toBe('Bot mention required');
    expect(getGroupMessageSkipReason(message({
      chatType: 'group',
      text: '/kill',
      mentions: ['ou_bot'],
    }), botConfig, 'ou_bot')).toBeUndefined();
  });
});
