import { describe, expect, it, vi } from 'vitest';
import type { ParsedRolloutLine } from '../src/notifications/codex-events.js';
import type { StructuredLifecycleEvent } from '../src/notifications/lifecycle-protocol.js';
import { CodexNotificationService } from '../src/notifications/service.js';
import { SessionStore } from '../src/session/store.js';

describe('structured completion cutover', () => {
  it('ignores JSONL completion and routes only explicit status completion', async () => {
    const store = await SessionStore.create(':memory:');
    const router = {
      resumePending: vi.fn(async () => undefined),
      handle: vi.fn(async (_event: unknown) => 'delivered' as const),
      stop: vi.fn(async () => undefined),
    };
    let onRollout: ((event: ParsedRolloutLine, path: string) => Promise<void> | void) | undefined;
    let onEvent: ((event: StructuredLifecycleEvent) => unknown) | undefined;
    const service = new CodexNotificationService({
      botName: 'codexbot',
      workingDirectory: '/work/power-trader-edu',
      sessionsDir: '/tmp/codex/sessions',
      sessionIndexPath: '/tmp/codex/session_index.jsonl',
      socketPath: '/tmp/cli2im-structured-test.sock',
      completionSource: 'structured',
      store,
      resolveAdapter: () => undefined,
      timeZone: 'UTC',
      dependencies: {
        router: router as any,
        metadataResolver: { resolve: vi.fn() } as any,
        createMonitor: (handler: (event: ParsedRolloutLine, path: string) => Promise<void> | void) => {
          onRollout = handler;
          return { start: async () => undefined, stop: async () => undefined };
        },
        createStructuredSocket: ((handler: (event: StructuredLifecycleEvent) => unknown) => {
          onEvent = handler;
          return { start: async () => undefined, stop: async () => undefined };
        }) as any,
        createOutbox: (() => ({ start: async () => undefined, stop: async () => undefined })) as any,
        readContextFile: vi.fn(async () => ''),
      } as any,
    });
    await service.start();

    const path = '/tmp/codex/sessions/rollout.jsonl';
    await onRollout?.({ type: 'session_meta', sessionId: 'session_1', cwd: '/work/power-trader-edu', source: 'codex-desktop' }, path);
    await onRollout?.({ type: 'turn_context', turnId: 'turn_1', cwd: '/work/power-trader-edu' }, path);
    await onRollout?.({ type: 'user_message', turnId: 'turn_1', userText: '生成宣传讲解 HTML PPT' }, path);
    await onRollout?.({ type: 'completed', turnId: 'turn_1', occurredAt: 1_100 }, path);
    expect(router.handle).not.toHaveBeenCalled();

    await onEvent?.({
      version: 1, type: 'user_prompt', eventKey: 'prompt', sessionId: 'session_1', turnId: 'turn_1',
      projectName: 'power-trader-edu', taskName: '生成宣传讲解 HTML PPT', occurredAt: 1_000,
    });
    await onEvent?.({
      version: 1, type: 'status_tool', eventKey: 'complete', sessionId: 'session_1', turnId: 'turn_1',
      toolUseId: 'tool_1', status: 'completed', occurredAt: 1_200,
    });
    expect(router.handle).toHaveBeenCalledTimes(1);
    expect(router.handle).toHaveBeenCalledWith(expect.objectContaining({ kind: 'completed' }));
    await service.stop();
    store.close();
  });
});
