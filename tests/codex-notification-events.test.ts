import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  eventKey,
  normalizePermissionHook,
  parseRolloutLine,
} from '../src/notifications/codex-events.js';

describe('Codex notification event parsing', () => {
  it('parses session and turn context into fresh allowlisted objects', () => {
    expect(parseRolloutLine(JSON.stringify({
      type: 'session_meta',
      payload: {
        id: 'session_1',
        cwd: '/Users/test/private/project',
        source: 'cli',
        secret: 'synthetic-secret',
      },
    }))).toEqual({
      type: 'session_meta',
      sessionId: 'session_1',
      cwd: '/Users/test/private/project',
      source: 'cli',
    });

    expect(parseRolloutLine(JSON.stringify({
      type: 'turn_context',
      payload: {
        turn_id: 'turn_1',
        cwd: '/Users/test/private/project',
        policy: 'synthetic-policy',
      },
    }))).toEqual({
      type: 'turn_context',
      turnId: 'turn_1',
      cwd: '/Users/test/private/project',
    });
  });

  it('extracts only a sanitized user-message title candidate', () => {
    const parsed = parseRolloutLine(JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{
          type: 'input_text',
          text: '<INSTRUCTIONS>ignore</INSTRUCTIONS>\n请检查 /Users/test/private/repo token=synthetic-secret-value',
        }],
        internal_chat_message_metadata_passthrough: { turn_id: 'turn_1' },
        raw_prompt: 'never retain this synthetic prompt',
      },
    }));

    expect(parsed).toEqual({
      type: 'user_message',
      turnId: 'turn_1',
      userText: '请检查 repo token=[REDACTED]',
    });
    expect(JSON.stringify(parsed)).not.toContain('/Users/test');
    expect(JSON.stringify(parsed)).not.toContain('synthetic-secret-value');
    expect(JSON.stringify(parsed)).not.toContain('never retain');
  });

  it('parses request_user_input as a question event without retaining arguments', () => {
    const line = JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'function_call', name: 'request_user_input', call_id: 'call_1',
        arguments: '{"questions":[{"question":"secret question"}]}',
        internal_chat_message_metadata_passthrough: { turn_id: 'turn_1' },
      },
    });
    expect(parseRolloutLine(line)).toEqual({ type: 'question', turnId: 'turn_1', requestId: 'call_1' });
    expect(JSON.stringify(parseRolloutLine(line))).not.toContain('secret question');
  });

  it('parses task_complete and turn_aborted separately', () => {
    expect(parseRolloutLine(JSON.stringify({
      type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn_1', completed_at: 1000, duration_ms: 2500 },
    }))).toEqual({ type: 'completed', turnId: 'turn_1', occurredAt: 1000, durationMs: 2500 });
    expect(parseRolloutLine(JSON.stringify({
      type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'turn_1', reason: 'interrupted' },
    }))).toEqual({ type: 'aborted', turnId: 'turn_1' });
  });

  it('ignores malformed and unrelated rollout lines', () => {
    expect(parseRolloutLine('not-json')).toBeNull();
    expect(parseRolloutLine(JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }))).toBeNull();
    expect(parseRolloutLine(JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant' } }))).toBeNull();
  });
});

describe('Codex permission hook normalization', () => {
  const base = {
    hook_event_name: 'PermissionRequest',
    session_id: 'session_1',
    turn_id: 'turn_1',
    approval_id: 'approval_1',
    request_id: 'request_1',
    tool_use_id: 'tool_1',
    tool_input: { password: 'synthetic-password' },
    command: 'print synthetic-secret',
    arguments: ['--token', 'synthetic-token'],
  };

  it('uses approval_id request_id and tool_use_id in priority order', () => {
    expect(normalizePermissionHook(base, 12_345)).toEqual({
      type: 'approval',
      sessionId: 'session_1',
      turnId: 'turn_1',
      requestId: 'approval_1',
      occurredAt: 12_345,
    });
    expect(normalizePermissionHook({ ...base, approval_id: undefined }, 12_345)?.requestId).toBe('request_1');
    expect(normalizePermissionHook({ ...base, approval_id: undefined, request_id: undefined }, 12_345)?.requestId).toBe('tool_1');
  });

  it('drops tool inputs commands and arguments from the normalized object and digest', () => {
    const withoutIds = {
      ...base,
      approval_id: undefined,
      request_id: undefined,
      tool_use_id: undefined,
    };
    const first = normalizePermissionHook(withoutIds, 10_001);
    const second = normalizePermissionHook({
      ...withoutIds,
      tool_input: { password: 'different-synthetic-password' },
      command: 'different synthetic command',
      arguments: ['different', 'synthetic', 'arguments'],
    }, 19_999);

    expect(first?.requestId).toBe(second?.requestId);
    expect(first?.requestId).toMatch(/^[a-f0-9]{24}$/);
    expect(JSON.stringify(first)).not.toContain('password');
    expect(JSON.stringify(first)).not.toContain('command');
    expect(JSON.stringify(first)).not.toContain('arguments');
    expect(normalizePermissionHook(withoutIds, 20_000)?.requestId).not.toBe(first?.requestId);
  });

  it('rejects unrelated or incomplete hook payloads', () => {
    expect(normalizePermissionHook(null, 1000)).toBeNull();
    expect(normalizePermissionHook({ ...base, hook_event_name: 'OtherHook' }, 1000)).toBeNull();
    expect(normalizePermissionHook({ ...base, session_id: undefined }, 1000)).toBeNull();
    expect(normalizePermissionHook({ ...base, turn_id: undefined }, 1000)).toBeNull();
  });
});

describe('eventKey', () => {
  it('returns the specified 24-character sha256 prefix', () => {
    const expected = createHash('sha256').update('session\u001fturn\u001frequest').digest('hex').slice(0, 24);
    expect(eventKey(['session', 'turn', 'request'])).toBe(expected);
  });
});
