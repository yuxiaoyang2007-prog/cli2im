import { describe, expect, it, vi } from 'vitest';
import { structuredEventKey, type StructuredLifecycleEvent } from '../src/notifications/lifecycle-protocol.js';
import { StructuredLifecycleService } from '../src/notifications/structured-lifecycle.js';
import { SessionStore } from '../src/session/store.js';

function userPrompt(turnId = 'turn_1'): Extract<StructuredLifecycleEvent, { type: 'user_prompt' }> {
  return {
    version: 1,
    type: 'user_prompt',
    eventKey: `prompt-${turnId}`,
    sessionId: 'session_1',
    turnId,
    projectName: 'power-trader-edu',
    taskName: '生成宣传讲解 HTML PPT',
    occurredAt: turnId === 'turn_1' ? 1_000 : 2_000,
  };
}

describe('structured Codex lifecycle service', () => {
  it('persists a task and emits only explicit attention and completion events', async () => {
    const store = await SessionStore.create(':memory:');
    const router = { handle: vi.fn(async (_event: unknown) => 'delivered') };
    const service = new StructuredLifecycleService({ store, router });
    await service.handle(userPrompt());
    expect(router.handle).not.toHaveBeenCalled();

    await service.handle({
      version: 1,
      type: 'approval_requested',
      eventKey: 'approval-event',
      sessionId: 'session_1',
      turnId: 'turn_1',
      requestId: 'request_1',
      occurredAt: 1_100,
    });
    expect(router.handle).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'needs_attention', reason: 'approval', projectName: 'power-trader-edu',
    }));

    await service.handle({
      version: 1,
      type: 'status_tool',
      eventKey: 'completed-event',
      sessionId: 'session_1',
      turnId: 'turn_1',
      toolUseId: 'tool_1',
      status: 'completed',
      occurredAt: 1_200,
    });
    expect(router.handle).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'completed', projectName: 'power-trader-edu', taskName: '生成宣传讲解 HTML PPT',
    }));
    expect((await store.getLatestCodexTask('session_1'))?.state).toBe('COMPLETED');
    store.close();
  });

  it('resumes a waiting task and rejects stale or inferred completion', async () => {
    const store = await SessionStore.create(':memory:');
    const router = { handle: vi.fn(async (_event: unknown) => 'delivered') };
    const service = new StructuredLifecycleService({ store, router });
    await service.handle(userPrompt());
    await service.handle({
      version: 1, type: 'status_tool', eventKey: 'waiting', sessionId: 'session_1',
      turnId: 'turn_1', toolUseId: 'tool_wait', status: 'waiting', reason: 'question', occurredAt: 1_100,
    });
    const taskId = (await store.getLatestCodexTask('session_1'))?.taskId;
    await service.handle(userPrompt('turn_2'));
    expect((await store.getLatestCodexTask('session_1'))).toMatchObject({ taskId, currentTurnId: 'turn_2' });

    await service.handle({
      version: 1, type: 'stop', eventKey: structuredEventKey(['stop']), sessionId: 'session_1',
      turnId: 'turn_2', stopHookActive: true, occurredAt: 2_100,
    });
    await service.handle({
      version: 1, type: 'status_tool', eventKey: 'stale-complete', sessionId: 'session_1',
      turnId: 'turn_stale', toolUseId: 'tool_stale', status: 'completed', occurredAt: 2_200,
    });
    expect(router.handle.mock.calls.filter(([event]) => (
      (event as { kind?: string }).kind === 'completed'
    ))).toHaveLength(0);
    expect((await store.getLatestCodexTask('session_1'))?.state).toBe('ENDED_UNREPORTED');
    store.close();
  });

  it('makes completed terminal and idempotent', async () => {
    const store = await SessionStore.create(':memory:');
    const router = { handle: vi.fn(async (_event: unknown) => 'delivered') };
    const service = new StructuredLifecycleService({ store, router });
    await service.handle(userPrompt());
    const event: StructuredLifecycleEvent = {
      version: 1, type: 'status_tool', eventKey: 'complete-once', sessionId: 'session_1',
      turnId: 'turn_1', toolUseId: 'tool_1', status: 'completed', occurredAt: 1_200,
    };
    await service.handle(event);
    await service.handle(event);
    expect(router.handle).toHaveBeenCalledTimes(1);
    store.close();
  });
});
