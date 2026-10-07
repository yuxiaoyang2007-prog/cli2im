import { describe, expect, it, vi } from 'vitest';
import { createPrivateSdkLogger, safeErrorFields, scrubLog } from '../src/security/logging.js';

describe('scrubLog', () => {
  it('removes log-breaking control characters while preserving tabs', () => {
    expect(scrubLog('voice line 1\nforged\r\x00entry\tok')).toBe('voice line 1forgedentry\tok');
  });

  it('limits long user-controlled log fields', () => {
    expect(scrubLog('a'.repeat(220), 12)).toBe(`${'a'.repeat(12)}...`);
  });
});

describe('private SDK diagnostics', () => {
  it('never serializes Axios config, response content, SDK strings or error messages', () => {
    const sink = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const error = Object.assign(new Error('secret-token in request URL'), {
      code: 'ERR_BAD_RESPONSE',
      config: { data: JSON.stringify({ app_secret: 'app-secret', text: 'private-conversation' }) },
      response: { status: 401, data: { token: 'response-token' } },
    });
    createPrivateSdkLogger('feishu').error(['SDK message private-conversation', error], 'secret-token');
    expect(sink).toHaveBeenCalledWith('[feishu] SDK error', { code: 'ERR_BAD_RESPONSE', status: 401 });
    expect(JSON.stringify(sink.mock.calls)).not.toMatch(/secret-token|app-secret|private-conversation|response-token/);
    sink.mockRestore();
  });

  it('does not trust arbitrary string values placed in error metadata', () => {
    expect(safeErrorFields({ code: 'my-secret-token', status: 'my-secret' })).toEqual({});
    expect(safeErrorFields(new Error('my-secret-token'))).toEqual({});
  });
});
