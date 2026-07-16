import { describe, expect, it } from 'vitest';
import {
  normalizeLifecycleHookInput,
  parseStructuredLifecycleEvent,
  safeProjectName,
  safeTaskTitle,
} from '../src/notifications/lifecycle-protocol.js';

describe('Codex structured lifecycle protocol', () => {
  it('normalizes a user prompt without retaining raw payload fields', () => {
    const event = normalizeLifecycleHookInput({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'session_1',
      turn_id: 'turn_1',
      cwd: '/work/power-trader-edu',
      prompt: '生成宣传讲解 HTML PPT',
      model: 'gpt-5',
      permission_mode: 'default',
    }, 1_000);

    expect(event).toMatchObject({
      version: 1,
      type: 'user_prompt',
      sessionId: 'session_1',
      turnId: 'turn_1',
      projectName: 'power-trader-edu',
      taskName: '生成宣传讲解 HTML PPT',
      occurredAt: 1_000,
    });
    expect(JSON.stringify(event)).not.toContain('/work/');
    expect(JSON.stringify(event)).not.toContain('permission_mode');
  });

  it('accepts only the two canonical status tools', () => {
    expect(normalizeLifecycleHookInput({
      hook_event_name: 'PostToolUse',
      session_id: 'session_1',
      turn_id: 'turn_1',
      cwd: '/work/project',
      tool_name: 'mcp__codex_task_notifier__mark_completed',
      tool_use_id: 'tool_1',
      tool_input: {},
      tool_response: { content: [{ type: 'text', text: 'recorded' }] },
    }, 2_000)).toMatchObject({
      type: 'status_tool',
      status: 'completed',
      toolUseId: 'tool_1',
    });

    expect(normalizeLifecycleHookInput({
      hook_event_name: 'PostToolUse',
      session_id: 'session_1',
      turn_id: 'turn_1',
      tool_name: 'mcp__something_else__mark_completed',
      tool_use_id: 'tool_2',
    }, 2_000)).toBeNull();
  });

  it('rejects malformed, unknown, and oversized hook payloads', () => {
    expect(normalizeLifecycleHookInput({ hook_event_name: 'Unknown' }, 1)).toBeNull();
    expect(normalizeLifecycleHookInput({
      hook_event_name: 'Stop', session_id: '', turn_id: 'turn_1', stop_hook_active: false,
    }, 1)).toBeNull();
    expect(normalizeLifecycleHookInput({
      hook_event_name: 'Stop', session_id: 's', turn_id: 't', filler: 'x'.repeat(9_000),
    }, 1)).toBeNull();
  });

  it('sanitizes task and project names', () => {
    expect(safeProjectName('/work/power-trader-edu')).toBe('power-trader-edu');
    expect(safeTaskTitle('token=secret123456789 生成 PPT\n第二行')).toBe('生成 PPT');
    expect(safeTaskTitle('')).toBe('未命名任务');
  });

  it('parses only exact allowlisted transport events', () => {
    const event = normalizeLifecycleHookInput({
      hook_event_name: 'Stop', session_id: 's', turn_id: 't', stop_hook_active: true,
    }, 3)!;
    expect(parseStructuredLifecycleEvent(event)).toEqual(event);
    expect(parseStructuredLifecycleEvent({ ...event, command: 'secret' })).toBeNull();
  });
});
