import { describe, expect, it } from 'vitest';
import { isAuthorizedBearerToken } from '../src/services/server.js';

describe('isAuthorizedBearerToken', () => {
  it('accepts the exact bearer token', () => {
    expect(isAuthorizedBearerToken('Bearer secret-token', 'secret-token')).toBe(true);
  });

  it('rejects same-length invalid bearer tokens', () => {
    expect(isAuthorizedBearerToken('Bearer secret-tokem', 'secret-token')).toBe(false);
  });

  it('rejects unequal-length tokens without throwing', () => {
    expect(isAuthorizedBearerToken('Bearer short', 'secret-token')).toBe(false);
    expect(isAuthorizedBearerToken(undefined, 'secret-token')).toBe(false);
  });
});
