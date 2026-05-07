import { describe, expect, it } from 'vitest';
import { toTelegramMarkdownV2 } from '../src/platforms/telegram/markdown.js';

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
