import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { StructuredLifecycleEvent } from '../src/notifications/lifecycle-protocol.js';
import {
  consumeProtocolContinuation,
  listOutboxEvents,
  loadHookTaskState,
  markProtocolContinuation,
  recordTurnStatus,
  registerUserPrompt,
  removeOutboxEvent,
  writeOutboxEvent,
} from '../src/notifications/task-state-files.js';

function prompt(turnId: string, occurredAt = 1_000): Extract<StructuredLifecycleEvent, { type: 'user_prompt' }> {
  return {
    version: 1,
    type: 'user_prompt',
    eventKey: `prompt-${turnId}`,
    sessionId: 'session-private',
    turnId,
    projectName: 'power-trader-edu',
    taskName: '生成宣传讲解 HTML PPT',
    occurredAt,
  };
}

describe('Hook task state files', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function root(): Promise<string> {
    const value = await mkdtemp(join(tmpdir(), 'cli2im-task-state-'));
    roots.push(value);
    return value;
  }

  it('resumes a waiting task without changing its identity or title', async () => {
    const dataRoot = await root();
    const first = await registerUserPrompt(dataRoot, prompt('turn_1'), false);
    expect(first).toMatchObject({ state: 'RUNNING', taskName: '生成宣传讲解 HTML PPT' });

    await recordTurnStatus(dataRoot, first, {
      status: 'waiting', turnId: 'turn_1', eventKey: 'evt_wait', occurredAt: 1_500,
    });
    const resumed = await registerUserPrompt(dataRoot, prompt('turn_2', 2_000), false);
    expect(resumed.taskId).toBe(first.taskId);
    expect(resumed.taskName).toBe(first.taskName);
    expect(resumed.currentTurnId).toBe('turn_2');
  });

  it('uses private hashed files and stores no raw prompt or path', async () => {
    const dataRoot = await root();
    await registerUserPrompt(dataRoot, prompt('turn_1'), false);
    const stateDir = join(dataRoot, 'codex-task-state');
    const [name] = await readdir(stateDir);
    const contents = await readFile(join(stateDir, name), 'utf8');

    expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(stateDir, name))).mode & 0o777).toBe(0o600);
    expect(name).not.toContain('session-private');
    expect(contents).not.toContain('/work/');
    expect(contents).not.toContain('prompt');
    expect(await loadHookTaskState(dataRoot, 'session-private')).not.toBeNull();
  });

  it('consumes a protocol continuation exactly once', async () => {
    const dataRoot = await root();
    const state = await registerUserPrompt(dataRoot, prompt('turn_1'), false);
    const token = await markProtocolContinuation(dataRoot, state);

    expect(await consumeProtocolContinuation(dataRoot, state.sessionId, token)).toBe(true);
    expect(await consumeProtocolContinuation(dataRoot, state.sessionId, token)).toBe(false);
  });

  it('orders outbox events and removes only the acknowledged file', async () => {
    const dataRoot = await root();
    const later = { ...prompt('turn_2', 2_000), eventKey: 'later' };
    const earlier = { ...prompt('turn_1', 1_000), eventKey: 'earlier' };
    await writeOutboxEvent(dataRoot, later);
    await writeOutboxEvent(dataRoot, earlier);

    const listed = await listOutboxEvents(dataRoot);
    expect(listed.map((item) => item.event.eventKey)).toEqual(['earlier', 'later']);
    await removeOutboxEvent(listed[0].path);
    expect((await listOutboxEvents(dataRoot)).map((item) => item.event.eventKey)).toEqual(['later']);
  });
});
