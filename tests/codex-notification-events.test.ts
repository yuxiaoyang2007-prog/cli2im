import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
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

  it('normalizes object-valued subagent sources without retaining the object', () => {
    const parsed = parseRolloutLine(JSON.stringify({
      type: 'session_meta',
      payload: {
        id: 'session_subagent',
        cwd: '/workspace/project',
        source: {
          subagent: { thread_spawn: { parent_thread_id: 'synthetic-parent' } },
          secret: 'synthetic-source-secret',
        },
      },
    }));

    expect(parsed).toEqual({
      type: 'session_meta',
      sessionId: 'session_subagent',
      cwd: '/workspace/project',
      source: 'subagent',
    });
    expect(JSON.stringify(parsed)).not.toContain('synthetic-parent');
    expect(JSON.stringify(parsed)).not.toContain('synthetic-source-secret');
  });

  it('normalizes allowlisted source and origin combinations', () => {
    function session(source: unknown, originator?: unknown) {
      return parseRolloutLine(JSON.stringify({
        type: 'session_meta',
        payload: {
          id: 'session_1',
          cwd: '/workspace/project',
          source,
          ...(originator === undefined ? {} : { originator }),
        },
      }));
    }

    expect(session('exec', 'Codex Desktop')).toMatchObject({ source: 'codex-desktop' });
    expect(session('exec', 'codex_exec')).toMatchObject({ source: 'cli' });
    expect(session('cli', 'codex-tui')).toMatchObject({ source: 'cli' });
    expect(session('vscode', 'codex_chrome_sidepanel')).toMatchObject({ source: 'codex' });
    expect(session('exec')).toMatchObject({ source: 'cli' });
    expect(session('vscode')).toMatchObject({ source: 'vscode' });
    expect(session('exec', 'synthetic-arbitrary-origin')).toMatchObject({ source: 'codex' });
    expect(JSON.stringify(session('exec', 'synthetic-arbitrary-origin'))).not.toContain('synthetic-arbitrary-origin');
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

  it('does not emit a raw technical user-message candidate', () => {
    const parsed = parseRolloutLine(JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'git diff -- src/private.ts' }],
        internal_chat_message_metadata_passthrough: { turn_id: 'turn_1' },
      },
    }));

    expect(parsed).toBeNull();
  });

  it('redacts a short valid Basic credential from a parsed user event', () => {
    const withContext = (text: string) => parseRolloutLine(JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message', role: 'user', content: [{ type: 'input_text', text }],
        internal_chat_message_metadata_passthrough: { turn_id: 'turn_basic' },
      },
    }));

    expect(withContext('Review Basic YTpwYXNz')).toEqual({
      type: 'user_message',
      turnId: 'turn_basic',
      userText: 'Review [REDACTED]',
    });
    expect(withContext('Basic YTpwYXNz')).toBeNull();
    expect(JSON.stringify(withContext('Review Basic YTpwYXNz'))).not.toContain('YTpwYXNz');
    expect(withContext('Review Basic YTpwYXNz.')).toEqual({
      type: 'user_message',
      turnId: 'turn_basic',
      userText: 'Review [REDACTED].',
    });
    expect(withContext('Review "Basic YTpwYXNz"')).toEqual({
      type: 'user_message',
      turnId: 'turn_basic',
      userText: 'Review "[REDACTED]"',
    });
  });

  it.each([
    'Review auth=abc123',
    'Review auth="alpha beta secret"',
  ])('fails closed for an auth assignment in a parsed user event: %s', (text) => {
    const parsed = parseRolloutLine(JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message', role: 'user', content: [{ type: 'input_text', text }],
        internal_chat_message_metadata_passthrough: { turn_id: 'turn_auth_assignment' },
      },
    }));

    expect(parsed).toEqual({
      type: 'user_message',
      turnId: 'turn_auth_assignment',
      userText: 'Review [REDACTED]',
    });
    expect(JSON.stringify(parsed)).not.toContain('abc123');
    expect(JSON.stringify(parsed)).not.toContain('alpha beta secret');
  });

  it('keeps a sanitized technical-looking attachment basename', () => {
    const parsed = parseRolloutLine(JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_file', filename: '/tmp/private/git diff.txt' }],
        internal_chat_message_metadata_passthrough: { turn_id: 'turn_1' },
      },
    }));

    expect(parsed).toEqual({
      type: 'user_message',
      turnId: 'turn_1',
      attachmentName: 'git diff.txt',
    });
    expect(JSON.stringify(parsed)).not.toContain('/tmp/private');
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

  it.each([
    [
      'Desktop/CLI passthrough metadata',
      { internal_chat_message_metadata_passthrough: { turn_id: 'turn_passthrough' } },
      'turn_passthrough',
    ],
    [
      'SDK metadata',
      { metadata: { turn_id: 'turn_sdk' } },
      'turn_sdk',
    ],
  ])('parses request_user_input turn id from %s', (_label, metadata, turnId) => {
    const parsed = parseRolloutLine(JSON.stringify({
      timestamp: '2026-07-15T18:32:10.250Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'request_user_input',
        call_id: 'call_structural',
        arguments: '{"questions":[{"question":"private structural secret"}]}',
        ...metadata,
      },
    }));

    expect(parsed).toEqual({
      type: 'question',
      turnId,
      requestId: 'call_structural',
      occurredAt: Date.parse('2026-07-15T18:32:10.250Z'),
    });
    expect(Object.keys(parsed ?? {}).sort()).toEqual([
      'occurredAt', 'requestId', 'turnId', 'type',
    ]);
    expect(JSON.stringify(parsed)).not.toContain('private structural secret');
  });

  it('retains only safe request metadata when request_user_input has no turn id', () => {
    const parsed = parseRolloutLine(JSON.stringify({
      timestamp: '2026-07-15T18:32:10.250Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'request_user_input',
        call_id: 'call_without_turn',
        arguments: '{"questions":[{"question":"private no-id secret"}]}',
        metadata: { unrelated: 'private metadata secret' },
      },
    }));

    expect(parsed).toEqual({
      type: 'question',
      requestId: 'call_without_turn',
      occurredAt: Date.parse('2026-07-15T18:32:10.250Z'),
    });
    expect(Object.keys(parsed ?? {}).sort()).toEqual(['occurredAt', 'requestId', 'type']);
    expect(JSON.stringify(parsed)).not.toContain('secret');
  });

  it('parses a valid outer ISO timestamp for request_user_input', () => {
    const timestamp = '2026-07-15T14:32:10.250-04:00';
    const parsed = parseRolloutLine(JSON.stringify({
      timestamp,
      type: 'response_item',
      payload: {
        type: 'function_call', name: 'request_user_input', call_id: 'call_timestamped',
        internal_chat_message_metadata_passthrough: { turn_id: 'turn_1' },
      },
    }));

    expect(parsed).toEqual({
      type: 'question',
      turnId: 'turn_1',
      requestId: 'call_timestamped',
      occurredAt: Date.parse(timestamp),
    });
  });

  it.each([
    '2026-07-15 14:32:10',
    '2026-07-15T14:32:10',
    'not-a-timestamp',
    '2026-13-99T99:99:99Z',
  ])('omits an invalid outer request_user_input timestamp: %s', (timestamp) => {
    expect(parseRolloutLine(JSON.stringify({
      timestamp,
      type: 'response_item',
      payload: {
        type: 'function_call', name: 'request_user_input', call_id: 'call_invalid_time',
        internal_chat_message_metadata_passthrough: { turn_id: 'turn_1' },
      },
    }))).toEqual({
      type: 'question', turnId: 'turn_1', requestId: 'call_invalid_time',
    });
  });

  it('classifies a final answer that asks for a choice without retaining its text', () => {
    const privatePrompt = [
      '先确认讲解时长，这会直接决定页数和展开深度：',
      '- A：约 15 分钟（推荐）',
      '- B：约 8 分钟',
      '回复 A、B 或 C 即可。',
    ].join('\n');
    const parsed = parseRolloutLine(JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: privatePrompt }],
        internal_chat_message_metadata_passthrough: { turn_id: 'turn_choice' },
      },
    }));

    expect(parsed).toEqual({
      type: 'assistant_state',
      turnId: 'turn_choice',
      awaitingUser: true,
    });
    expect(JSON.stringify(parsed)).not.toContain(privatePrompt);
    expect(JSON.stringify(parsed)).not.toContain('HTML');
  });

  it('classifies a final confirmation question as awaiting the user', () => {
    expect(parseRolloutLine(JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: '确认按“方案一 + 16 页结构”执行吗？' }],
        internal_chat_message_metadata_passthrough: { turn_id: 'turn_confirm' },
      },
    }))).toEqual({
      type: 'assistant_state',
      turnId: 'turn_confirm',
      awaitingUser: true,
    });
  });

  it('classifies a delivered final answer as not awaiting the user', () => {
    expect(parseRolloutLine(JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: '已修改并完成导出，两个问题均已处理。' }],
        internal_chat_message_metadata_passthrough: { turn_id: 'turn_delivered' },
      },
    }))).toEqual({
      type: 'assistant_state',
      turnId: 'turn_delivered',
      awaitingUser: false,
    });
  });

  it('does not treat an optional follow-up after delivery as blocking', () => {
    expect(parseRolloutLine(JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'final_answer',
        content: [{
          type: 'output_text',
          text: '已完成并导出。如需调整，回复我即可。',
        }],
        internal_chat_message_metadata_passthrough: { turn_id: 'turn_optional_followup' },
      },
    }))).toEqual({
      type: 'assistant_state',
      turnId: 'turn_optional_followup',
      awaitingUser: false,
    });
  });

  it.each([
    ['GitHub PAT', 'ghp_1234567890abcdefghijklmnopqrstuvwxyzAB'],
    ['AWS access key', 'AKIAIOSFODNN7EXAMPLE'],
    ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'],
    ['Bearer credential', 'Bearer mF_9xQ7vK2pL8sN4dR6tY1wB3cE5hJ0z'],
    ['Authorization credential', 'Authorization: Basic YWxhZGRpbjpvcGVuc2VzYW1l'],
    ['signed URL credential', 'https://example.test/a?X-Amz-Signature=0123456789abcdef0123456789abcdef'],
    ['webhook secret', 'https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX'],
    ['high-entropy credential', 'mF_9xQ7vK2pL8sN4dR6tY1wB3cE5hJ0z'],
  ])('never retains a %s in a parsed user event', (_kind, credential) => {
    const parsed = parseRolloutLine(JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message', role: 'user',
        content: [{ type: 'input_text', text: `Review ${credential}` }],
        internal_chat_message_metadata_passthrough: { turn_id: 'turn_secret' },
      },
    }));

    expect(JSON.stringify(parsed)).not.toContain(credential);
  });

  it('does not write credential-bearing rollout content to logs', () => {
    const credential = 'ghp_1234567890abcdefghijklmnopqrstuvwxyzAB';
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ];
    try {
      const parsed = parseRolloutLine(JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message', role: 'user',
          content: [{ type: 'input_text', text: `Review ${credential}` }],
          internal_chat_message_metadata_passthrough: { turn_id: 'turn_secret_log' },
        },
      }));

      expect(JSON.stringify(parsed)).not.toContain(credential);
      expect(spies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
      expect(JSON.stringify(spies.map((spy) => spy.mock.calls))).not.toContain(credential);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('prefers the outer ISO timestamp for a real-format task_complete', () => {
    const timestamp = '2026-07-15T18:35:18.250Z';
    expect(parseRolloutLine(JSON.stringify({
      timestamp,
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'turn_1',
        completed_at: Date.parse('2026-07-15T18:35:18Z') / 1000,
        duration_ms: 2500,
      },
    }))).toEqual({
      type: 'completed',
      turnId: 'turn_1',
      occurredAt: Date.parse(timestamp),
      durationMs: 2500,
    });
  });

  it('normalizes plausible task_complete fallback timestamps to milliseconds', () => {
    const seconds = Date.parse('2026-07-15T18:35:18Z') / 1000;
    const milliseconds = Date.parse('2026-07-15T18:35:18.250Z');

    expect(parseRolloutLine(JSON.stringify({
      timestamp: 'invalid-outer-time',
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'turn_seconds', completed_at: seconds },
    }))).toEqual({
      type: 'completed', turnId: 'turn_seconds', occurredAt: seconds * 1000,
    });
    expect(parseRolloutLine(JSON.stringify({
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'turn_milliseconds', completed_at: milliseconds },
    }))).toEqual({
      type: 'completed', turnId: 'turn_milliseconds', occurredAt: milliseconds,
    });
  });

  it.each([-1, 1_000, 100_000_000_000_000])(
    'rejects an implausible task_complete fallback timestamp: %s',
    (completedAt) => {
      expect(parseRolloutLine(JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'turn_invalid', completed_at: completedAt },
      }))).toBeNull();
    },
  );

  it('parses turn_aborted separately from completion', () => {
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

  it('uses normalized tool_name only inside the id-less approval digest', () => {
    const withoutIds = {
      ...base,
      approval_id: undefined,
      request_id: undefined,
      tool_use_id: undefined,
    };
    const shell = normalizePermissionHook({ ...withoutIds, tool_name: '  Shell  ' }, 15_000);
    const normalizedShell = normalizePermissionHook({ ...withoutIds, tool_name: 'shell' }, 15_000);
    const fileWrite = normalizePermissionHook({ ...withoutIds, tool_name: 'FileWrite' }, 15_000);

    expect(shell?.requestId).toBe(normalizedShell?.requestId);
    expect(shell?.requestId).not.toBe(fileWrite?.requestId);
    expect(Object.keys(shell ?? {}).sort()).toEqual([
      'occurredAt', 'requestId', 'sessionId', 'turnId', 'type',
    ]);
    expect(JSON.stringify([shell, fileWrite])).not.toContain('Shell');
    expect(JSON.stringify([shell, fileWrite])).not.toContain('FileWrite');
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
