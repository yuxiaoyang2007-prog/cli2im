import { describe, expect, it } from 'vitest';
import { toTelegramMarkdownV2, buildCLISessionText } from '../src/platforms/telegram/markdown.js';
import type { CLISession } from '../src/session/cli-scanner.js';

describe('toTelegramMarkdownV2', () => {
  it('escapes MarkdownV2 special characters outside code', () => {
    expect(toTelegramMarkdownV2('_*[]()~>#+-=|{}.!')).toBe(
      '\\_\\*\\[\\]\\(\\)\\~\\>\\#\\+\\-\\=\\|\\{\\}\\.\\!',
    );
  });

  it('preserves inline code without escaping its content', () => {
    expect(toTelegramMarkdownV2('Use `a_b*1` now.')).toBe('Use `a_b*1` now\\.');
  });

  it('preserves fenced code blocks without double-escaping', () => {
    const input = ['Before *bold*', '```ts', 'const x = a_b + 1;', '```', 'After!'].join('\n');

    expect(toTelegramMarkdownV2(input)).toBe(
      ['Before \\*bold\\*', '```ts', 'const x = a_b + 1;', '```', 'After\\!'].join('\n'),
    );
  });

  it('does not double-escape existing escapes outside code', () => {
    expect(toTelegramMarkdownV2('Already \\*escaped\\* and raw *bold*')).toBe(
      'Already \\*escaped\\* and raw \\*bold\\*',
    );
  });
});

describe('buildCLISessionText', () => {
  const now = Date.now();

  function session(overrides: Partial<CLISession> = {}): CLISession {
    return {
      sessionId: '9f53e234-c06b-44e6-b71e-3e1a4b618123',
      cwd: '/Users/test/projects/foo',
      title: 'Test session',
      lastModified: now - 60_000,
      status: 'idle',
      fileSize: 2048,
      gitBranch: 'main',
      ...overrides,
    };
  }

  it('returns a CardPayload with buttons using compact resume format', () => {
    const result = buildCLISessionText([session()]);
    expect(result.type).toBe('session_list');
    expect(result.buttons).toHaveLength(1);
    expect(result.buttons![0].value).toBe('resume:9f53e234-c06b-44e6-b71e-3e1a4b618123');
    expect(result.buttons![0].text).toBe('Test session');
  });

  it('marks busy sessions in button text', () => {
    const result = buildCLISessionText([session({ status: 'busy' })]);
    expect(result.buttons![0].text).toBe('Test session (busy)');
  });

  it('button value fits in Telegram 64-byte callback_data limit', () => {
    const result = buildCLISessionText([session()]);
    const bytes = Buffer.byteLength(result.buttons![0].value, 'utf8');
    expect(bytes).toBeLessThanOrEqual(64);
  });

  it('includes session info in content text', () => {
    const result = buildCLISessionText([session()]);
    expect(result.content).toContain('Test session');
    expect(result.content).toContain('Showing 1 sessions');
  });
});
