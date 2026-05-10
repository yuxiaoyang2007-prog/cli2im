import { describe, it, expect } from 'vitest';
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
    expect(isBridgeCommand('/thinking')).toBe(true);
    expect(isBridgeCommand('/fast')).toBe(true);
    expect(isBridgeCommand('/perm allow req_123')).toBe(true);
    expect(isBridgeCommand('/sessions')).toBe(true);
  });

  it('does not recognize CLI passthrough commands', () => {
    expect(isBridgeCommand('/compact')).toBe(false);
    expect(isBridgeCommand('/review')).toBe(false);
    expect(isBridgeCommand('/cost')).toBe(false);
    expect(isBridgeCommand('/doctor')).toBe(false);
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

  it('parses /switch with args', () => {
    const cmd = parseBridgeCommand('/switch ses_abc123');
    expect(cmd).toEqual({ command: 'switch', args: ['ses_abc123'] });
  });

  it('parses /cwd with path', () => {
    const cmd = parseBridgeCommand('/cwd ~/projects/newsradar');
    expect(cmd).toEqual({ command: 'cwd', args: ['~/projects/newsradar'] });
  });

  it('parses /model with name', () => {
    const cmd = parseBridgeCommand('/model claude-sonnet-4-20250514');
    expect(cmd).toEqual({ command: 'model', args: ['claude-sonnet-4-20250514'] });
  });

  it('parses /perm with decision and request id', () => {
    const cmd = parseBridgeCommand('/perm allow req_123');
    expect(cmd).toEqual({ command: 'perm', args: ['allow', 'req_123'] });
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

  it('requires bot mention in groups but exempts bridge commands', () => {
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
      text: '/status',
      mentions: [],
    }), botConfig, 'ou_bot')).toBeUndefined();
  });
});
