import { describe, it, expect } from 'vitest';
import { validateWorkingDirectory, sanitizeInput } from '../src/security/validators.js';
import { RateLimiter } from '../src/security/rate-limiter.js';

describe('validateWorkingDirectory', () => {
  it('accepts valid home-relative paths', () => {
    expect(validateWorkingDirectory('~/projects')).toBe(true);
    expect(validateWorkingDirectory('~/projects/newsradar')).toBe(true);
  });

  it('accepts absolute paths under home', () => {
    expect(validateWorkingDirectory('/Users/test/projects')).toBe(true);
  });

  it('rejects path traversal', () => {
    expect(validateWorkingDirectory('~/../../etc')).toBe(false);
    expect(validateWorkingDirectory('../..')).toBe(false);
  });

  it('rejects system paths', () => {
    expect(validateWorkingDirectory('/etc')).toBe(false);
    expect(validateWorkingDirectory('/usr/bin')).toBe(false);
  });
});

describe('sanitizeInput', () => {
  it('trims whitespace', () => {
    expect(sanitizeInput('  hello  ')).toBe('hello');
  });

  it('limits length', () => {
    const long = 'a'.repeat(100000);
    const sanitized = sanitizeInput(long);
    expect(sanitized.length).toBeLessThanOrEqual(50000);
  });
});

describe('RateLimiter', () => {
  it('allows messages under limit', () => {
    const limiter = new RateLimiter(5, 60000);
    for (let i = 0; i < 5; i++) {
      expect(limiter.check('chat1')).toBe(true);
    }
  });

  it('blocks messages over limit', () => {
    const limiter = new RateLimiter(3, 60000);
    expect(limiter.check('chat1')).toBe(true);
    expect(limiter.check('chat1')).toBe(true);
    expect(limiter.check('chat1')).toBe(true);
    expect(limiter.check('chat1')).toBe(false);
  });

  it('tracks per chat independently', () => {
    const limiter = new RateLimiter(2, 60000);
    expect(limiter.check('chat1')).toBe(true);
    expect(limiter.check('chat1')).toBe(true);
    expect(limiter.check('chat1')).toBe(false);
    expect(limiter.check('chat2')).toBe(true);
  });
});
