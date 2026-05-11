import { describe, expect, it } from 'vitest';
import { scrubLog } from '../src/security/logging.js';

describe('scrubLog', () => {
  it('removes log-breaking control characters while preserving tabs', () => {
    expect(scrubLog('voice line 1\nforged\r\x00entry\tok')).toBe('voice line 1forgedentry\tok');
  });

  it('limits long user-controlled log fields', () => {
    expect(scrubLog('a'.repeat(220), 12)).toBe(`${'a'.repeat(12)}...`);
  });
});
