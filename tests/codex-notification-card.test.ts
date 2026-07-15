import { describe, expect, it } from 'vitest';
import { buildNotificationCard } from '../src/notifications/card.js';
import type { CodexNotificationEvent } from '../src/notifications/types.js';

function attentionEvent(
  overrides: Partial<CodexNotificationEvent> = {},
): CodexNotificationEvent {
  return {
    eventKey: 'evt_attention',
    kind: 'needs_attention',
    reason: 'approval',
    sessionId: 'abcdefgh-1234',
    turnId: 'turn_1',
    requestId: 'request_1',
    projectName: 'cli2im',
    taskName: '为所有 Codex 任务增加飞书提醒',
    surface: 'ChatGPT Work',
    occurredAt: new Date('2026-07-15T14:32:00-04:00').getTime(),
    shortTaskId: 'abcdefgh',
    ...overrides,
  };
}

function completionEvent(
  overrides: Partial<CodexNotificationEvent> = {},
): CodexNotificationEvent {
  return {
    eventKey: 'evt_completed',
    kind: 'completed',
    sessionId: 'abcdefgh-1234',
    turnId: 'turn_1',
    projectName: 'cli2im',
    taskName: '为所有 Codex 任务增加飞书提醒',
    surface: 'ChatGPT Work',
    occurredAt: new Date('2026-07-15T14:35:18-04:00').getTime(),
    durationMs: 198_000,
    shortTaskId: 'abcdefgh',
    ...overrides,
  };
}

describe('buildNotificationCard', () => {
  it('renders the exact orange approval card content', () => {
    expect(buildNotificationCard(attentionEvent(), {
      delayed: false,
      timeZone: 'America/New_York',
    })).toEqual({
      type: 'final',
      title: '🟠 待你处理',
      headerTemplate: 'orange',
      content: [
        '**项目：** cli2im',
        '**任务：** 为所有 Codex 任务增加飞书提醒',
        '**原因：** 需要批准操作',
        '**位置：** ChatGPT Work',
        '**时间：** 14:32',
        '**任务 ID：** abcdefgh',
      ].join('\n'),
    });
  });

  it('renders the exact green completion card with completion time and duration', () => {
    expect(buildNotificationCard(completionEvent(), {
      delayed: false,
      timeZone: 'America/New_York',
    })).toEqual({
      type: 'final',
      title: '🟢 任务完成',
      headerTemplate: 'green',
      content: [
        '**项目：** cli2im',
        '**任务：** 为所有 Codex 任务增加飞书提醒',
        '**位置：** ChatGPT Work',
        '**完成：** 14:35',
        '**耗时：** 3 分 18 秒',
        '**任务 ID：** abcdefgh',
      ].join('\n'),
    });
  });

  it('always renders the completion duration with an exact unknown fallback', () => {
    const card = buildNotificationCard(completionEvent({ durationMs: undefined }), {
      delayed: false,
      timeZone: 'America/New_York',
    });

    expect(card.content.split('\n')).toContain('**耗时：** 未知');
  });

  it('adds the delayed marker as the final line', () => {
    const card = buildNotificationCard(attentionEvent({ reason: 'question' }), {
      delayed: true,
      timeZone: 'America/New_York',
    });

    expect(card.content.split('\n').at(-1)).toBe('⚠️ 延迟送达');
    expect(card.content).toContain('**原因：** 需要回答问题');
  });

  it('escapes every event value and ignores arbitrary raw card or payload fields', () => {
    const event = Object.assign(attentionEvent({
      projectName: '[cli2im]_project',
      taskName: '*task* `code`',
      surface: 'IDE',
      shortTaskId: '[abcd]_`id`',
    }), {
      rawElements: [{ tag: 'markdown', content: 'RAW_SECRET_OUTPUT' }],
      buttons: [{ text: 'approve', value: 'RAW_COMMAND' }],
      prompt: 'RAW_PROMPT',
      command: 'RAW_COMMAND',
      path: '/Users/private/project',
      log: 'RAW_LOG',
      diff: 'RAW_DIFF',
      secret: 'RAW_SECRET',
      output: 'RAW_OUTPUT',
    });

    const card = buildNotificationCard(event, {
      delayed: false,
      timeZone: 'America/New_York',
    });

    expect(card.content).toContain('\\[cli2im\\]\\_project');
    expect(card.content).toContain('\\*task\\* \\`code\\`');
    expect(card.content).toContain('\\[abcd\\]\\_\\`id\\`');
    expect(card).not.toHaveProperty('rawElements');
    expect(card).not.toHaveProperty('buttons');
    expect(JSON.stringify(card)).not.toMatch(/RAW_|\/Users\/private/);
  });

  it('normalizes adversarial dynamic values into one safe plain-text line each', () => {
    const attack = [
      'first\r\n\tsecond\u0000',
      '~~strike~~ <at id=ou_secret>mention</at>',
      '[click](https://example.test?q=secret) `code` *bold* _em_',
      '\\path | # heading',
    ].join('');
    const card = buildNotificationCard(attentionEvent({
      projectName: attack,
      taskName: attack,
      surface: attack as CodexNotificationEvent['surface'],
      shortTaskId: attack,
    }), {
      delayed: false,
      timeZone: 'America/New_York',
    });

    expect(card.content.split('\n')).toHaveLength(6);
    expect(card.content).not.toMatch(/[\r\t\u0000]/u);
    expect(card.content).not.toContain('~~');
    expect(card.content).not.toContain('<at');
    expect(card.content).not.toContain('[click](');
    expect(card.content).not.toContain('`code`');
    expect(card.content).not.toContain('*bold*');
    expect(card.content).not.toContain('_em_');
    expect(card.content).not.toMatch(/(?<!\\)[|#]/u);
    expect(card.content).toContain('first second');
  });
});
