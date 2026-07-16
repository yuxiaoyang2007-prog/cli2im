import { mkdtemp, rm } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runLifecycleHook } from '../src/notifications/lifecycle-hook-client.js';
import { listOutboxEvents, loadHookTaskState } from '../src/notifications/task-state-files.js';

function input(value: unknown): Readable {
  return Readable.from([JSON.stringify(value)]);
}

function capture(): { output: Writable; text: () => string } {
  let value = '';
  return {
    output: new Writable({ write(chunk, _encoding, done) { value += chunk.toString(); done(); } }),
    text: () => value,
  };
}

describe('Codex lifecycle Hook client', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function setup() {
    const dataRoot = await mkdtemp(join(tmpdir(), 'cli2im-hook-'));
    roots.push(dataRoot);
    const sendEvent = vi.fn(async () => undefined);
    return { dataRoot, sendEvent, now: () => 1_000 };
  }

  const userPrompt = {
    hook_event_name: 'UserPromptSubmit',
    session_id: 'session_1',
    turn_id: 'turn_1',
    cwd: '/work/power-trader-edu',
    prompt: '生成宣传讲解 HTML PPT',
  };

  it('registers a task, injects status protocol context, and writes before sending', async () => {
    const options = await setup();
    const stdout = capture();
    await runLifecycleHook(input(userPrompt), stdout.output, options);

    expect(JSON.parse(stdout.text())).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: expect.stringContaining('mark_completed'),
      },
    });
    expect((await listOutboxEvents(options.dataRoot))).toHaveLength(1);
    expect(options.sendEvent).toHaveBeenCalledTimes(1);
  });

  it('blocks the first unreported Stop and allows the second without a green event', async () => {
    const options = await setup();
    await runLifecycleHook(input(userPrompt), capture().output, options);

    const first = capture();
    await runLifecycleHook(input({
      hook_event_name: 'Stop', session_id: 'session_1', turn_id: 'turn_1', stop_hook_active: false,
    }), first.output, options);
    expect(JSON.parse(first.text())).toEqual({
      decision: 'block',
      reason: expect.stringContaining('mark_waiting or mark_completed'),
    });

    const second = capture();
    await runLifecycleHook(input({
      hook_event_name: 'Stop', session_id: 'session_1', turn_id: 'turn_1', stop_hook_active: true,
    }), second.output, options);
    expect(JSON.parse(second.text())).toEqual({ continue: true });
    expect((await loadHookTaskState(options.dataRoot, 'session_1'))?.state).toBe('ENDED_UNREPORTED');
    expect((await listOutboxEvents(options.dataRoot)).filter(({ event }) => (
      event.type === 'status_tool' && event.status === 'completed'
    ))).toHaveLength(0);
  });

  it('records a status marker before allowing Stop', async () => {
    const options = await setup();
    await runLifecycleHook(input(userPrompt), capture().output, options);
    await runLifecycleHook(input({
      hook_event_name: 'PostToolUse',
      session_id: 'session_1',
      turn_id: 'turn_1',
      tool_name: 'mcp__codex_task_notifier__mark_completed',
      tool_use_id: 'tool_1',
      tool_input: {},
      tool_response: {},
    }), capture().output, options);

    const stopped = capture();
    await runLifecycleHook(input({
      hook_event_name: 'Stop', session_id: 'session_1', turn_id: 'turn_1', stop_hook_active: false,
    }), stopped.output, options);
    expect(JSON.parse(stopped.text())).toEqual({ continue: true });
  });

  it('sends approval attention but does not count it as a final turn status', async () => {
    const options = await setup();
    await runLifecycleHook(input(userPrompt), capture().output, options);
    await runLifecycleHook(input({
      hook_event_name: 'PermissionRequest',
      session_id: 'session_1', turn_id: 'turn_1', approval_id: 'approval_1',
      tool_input: { command: 'private command' },
    }), capture().output, options);

    const state = await loadHookTaskState(options.dataRoot, 'session_1');
    expect(state?.state).toBe('WAITING_APPROVAL');
    expect(state?.reportedTurnId).toBeUndefined();
    expect(JSON.stringify(await listOutboxEvents(options.dataRoot))).not.toContain('private command');
  });

  it('keeps malformed input and unavailable transport silent and successful', async () => {
    const options = await setup();
    options.sendEvent.mockRejectedValueOnce(new Error('socket unavailable'));
    await expect(runLifecycleHook(Readable.from(['{bad']), capture().output, options)).resolves.toBeUndefined();
    await expect(runLifecycleHook(input(userPrompt), capture().output, options)).resolves.toBeUndefined();
    expect(await listOutboxEvents(options.dataRoot)).toHaveLength(1);
  });
});
