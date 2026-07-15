import { describe, expect, it, vi } from 'vitest';
import { eventKey, type ParsedRolloutLine, type PermissionHookEvent } from '../src/notifications/codex-events.js';
import { CodexNotificationService } from '../src/notifications/service.js';
import type { NotificationMetadataResolver } from '../src/notifications/metadata.js';
import type { NotificationRouter } from '../src/notifications/router.js';
import type { SessionStore } from '../src/session/store.js';

describe('CodexNotificationService', () => {
  it('starts and stops dependencies in order and routes stable question and completion events', async () => {
    const order: string[] = [];
    let onRollout: ((event: ParsedRolloutLine, filePath: string) => void | Promise<void>) | undefined;
    let onApproval: ((event: PermissionHookEvent) => void | Promise<void>) | undefined;
    const router = {
      resumePending: vi.fn(async () => { order.push('router.resume'); }),
      handle: vi.fn(async () => 'delivered'),
      stop: vi.fn(() => { order.push('router.stop'); }),
    } as unknown as NotificationRouter;
    const metadataResolver = {
      resolve: vi.fn(async () => ({
        projectName: 'cli2im',
        taskName: '飞书通知上线',
        surface: 'Codex Desktop' as const,
        shortTaskId: 'session_',
      })),
    } as unknown as NotificationMetadataResolver;
    const store = {
      bindNotificationTarget: vi.fn().mockResolvedValue(undefined),
    } as unknown as SessionStore;

    const service = new CodexNotificationService({
      botName: 'codexbot',
      workingDirectory: '/tmp/project',
      sessionsDir: '/tmp/codex/sessions',
      sessionIndexPath: '/tmp/codex/session_index.jsonl',
      socketPath: '/tmp/cli2im/codex-notify.sock',
      store,
      resolveAdapter: () => undefined,
      timeZone: 'America/New_York',
      now: () => 2_000,
      dependencies: {
        router,
        metadataResolver,
        createMonitor: (handler) => {
          onRollout = handler;
          return {
            start: vi.fn(async () => { order.push('monitor.start'); }),
            stop: vi.fn(async () => { order.push('monitor.stop'); }),
          };
        },
        createSocket: (handler) => {
          onApproval = handler;
          return {
            start: vi.fn(async () => { order.push('socket.start'); }),
            stop: vi.fn(async () => { order.push('socket.stop'); }),
          };
        },
        readContextFile: vi.fn().mockResolvedValue(''),
      },
    });

    await service.start();
    expect(order).toEqual(['router.resume', 'socket.start', 'monitor.start']);

    const filePath = '/tmp/codex/sessions/rollout-test.jsonl';
    await onRollout?.({
      type: 'session_meta',
      sessionId: 'session_12345678',
      cwd: '/tmp/project',
      source: 'codex-desktop',
    }, filePath);
    await onRollout?.({ type: 'turn_context', turnId: 'turn_1', cwd: '/tmp/project' }, filePath);
    await onRollout?.({ type: 'user_message', turnId: 'turn_1', userText: '飞书通知上线' }, filePath);
    await onRollout?.({ type: 'question', turnId: 'turn_1', requestId: 'request_1' }, filePath);
    await onRollout?.({
      type: 'completed',
      turnId: 'turn_1',
      occurredAt: 3_000,
      durationMs: 1_000,
    }, filePath);
    await onApproval?.({
      type: 'approval',
      sessionId: 'session_12345678',
      turnId: 'turn_1',
      requestId: 'approval_1',
      occurredAt: 2_500,
    });

    expect(metadataResolver.resolve).toHaveBeenCalledWith({
      sessionId: 'session_12345678',
      cwd: '/tmp/project',
      source: 'codex-desktop',
      userText: '飞书通知上线',
      attachmentName: undefined,
    });
    expect(router.handle).toHaveBeenNthCalledWith(1, {
      eventKey: eventKey(['session_12345678', 'turn_1', 'request_1', 'question']),
      kind: 'needs_attention',
      reason: 'question',
      sessionId: 'session_12345678',
      turnId: 'turn_1',
      requestId: 'request_1',
      projectName: 'cli2im',
      taskName: '飞书通知上线',
      surface: 'Codex Desktop',
      occurredAt: 2_000,
      shortTaskId: 'session_',
    });
    expect(router.handle).toHaveBeenNthCalledWith(2, {
      eventKey: eventKey(['session_12345678', 'turn_1', 'completed']),
      kind: 'completed',
      sessionId: 'session_12345678',
      turnId: 'turn_1',
      projectName: 'cli2im',
      taskName: '飞书通知上线',
      surface: 'Codex Desktop',
      occurredAt: 3_000,
      durationMs: 1_000,
      shortTaskId: 'session_',
    });
    expect(router.handle).toHaveBeenNthCalledWith(3, {
      eventKey: eventKey(['session_12345678', 'turn_1', 'approval_1', 'approval']),
      kind: 'needs_attention',
      reason: 'approval',
      sessionId: 'session_12345678',
      turnId: 'turn_1',
      requestId: 'approval_1',
      projectName: 'cli2im',
      taskName: '飞书通知上线',
      surface: 'Codex Desktop',
      occurredAt: 2_500,
      shortTaskId: 'session_',
    });

    await service.stop();
    expect(order).toEqual([
      'router.resume',
      'socket.start',
      'monitor.start',
      'monitor.stop',
      'socket.stop',
      'router.stop',
    ]);
  });

  it('persists only a matching Feishu binding', async () => {
    const store = {
      bindNotificationTarget: vi.fn().mockResolvedValue(undefined),
    } as unknown as SessionStore;
    const service = new CodexNotificationService({
      botName: 'codexbot',
      workingDirectory: '/tmp/project',
      sessionsDir: '/tmp/codex/sessions',
      sessionIndexPath: '/tmp/codex/session_index.jsonl',
      socketPath: '/tmp/cli2im/codex-notify.sock',
      store,
      resolveAdapter: () => undefined,
      timeZone: 'UTC',
    });

    await service.bindTarget({
      botName: 'codexbot',
      platform: 'feishu',
      chatId: 'oc_private',
      userId: 'ou_allowed',
    });

    expect(store.bindNotificationTarget).toHaveBeenCalledWith({
      botName: 'codexbot',
      platform: 'feishu',
      chatId: 'oc_private',
      userId: 'ou_allowed',
      updatedAt: expect.any(Number),
    });
    await expect(service.bindTarget({
      botName: 'otherbot',
      platform: 'feishu',
      chatId: 'oc_private',
      userId: 'ou_allowed',
    })).rejects.toThrow('Invalid notification binding target');
  });

  it('hydrates prior rollout context before routing the first appended event after restart', async () => {
    let onRollout: ((event: ParsedRolloutLine, filePath: string) => void | Promise<void>) | undefined;
    const router = {
      resumePending: vi.fn().mockResolvedValue(undefined),
      handle: vi.fn().mockResolvedValue('delivered'),
      stop: vi.fn(),
    } as unknown as NotificationRouter;
    const metadataResolver = {
      resolve: vi.fn(async () => ({
        projectName: 'restored-project',
        taskName: '恢复后的任务',
        surface: 'CLI' as const,
        shortTaskId: 'session_',
      })),
    } as unknown as NotificationMetadataResolver;
    const historicalContext = [
      JSON.stringify({
        type: 'session_meta',
        payload: { id: 'session_restart', cwd: '/tmp/restored-project', source: 'cli' },
      }),
      JSON.stringify({
        type: 'turn_context',
        payload: { turn_id: 'turn_restart', cwd: '/tmp/restored-project' },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '恢复后的任务' }],
          internal_chat_message_metadata_passthrough: { turn_id: 'turn_restart' },
        },
      }),
    ].join('\n');
    const service = new CodexNotificationService({
      botName: 'codexbot',
      workingDirectory: '/tmp/fallback',
      sessionsDir: '/tmp/codex/sessions',
      sessionIndexPath: '/tmp/codex/session_index.jsonl',
      socketPath: '/tmp/cli2im/codex-notify.sock',
      store: { bindNotificationTarget: vi.fn() } as unknown as SessionStore,
      resolveAdapter: () => undefined,
      timeZone: 'UTC',
      dependencies: {
        router,
        metadataResolver,
        createMonitor: (handler) => {
          onRollout = handler;
          return { start: vi.fn(), stop: vi.fn() };
        },
        createSocket: () => ({ start: vi.fn(), stop: vi.fn() }),
        readContextFile: vi.fn().mockResolvedValue(historicalContext),
      },
    });

    await onRollout?.({
      type: 'completed',
      turnId: 'turn_restart',
      occurredAt: 5_000,
    }, '/tmp/codex/sessions/rollout-restart.jsonl');

    expect(metadataResolver.resolve).toHaveBeenCalledWith({
      sessionId: 'session_restart',
      cwd: '/tmp/restored-project',
      source: 'cli',
      userText: '恢复后的任务',
      attachmentName: undefined,
    });
    expect(router.handle).toHaveBeenCalledWith(expect.objectContaining({
      eventKey: eventKey(['session_restart', 'turn_restart', 'completed']),
      projectName: 'restored-project',
      taskName: '恢复后的任务',
    }));
  });

  it('isolates lifecycle failures with safe summaries and continues remaining steps', async () => {
    const order: string[] = [];
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const service = new CodexNotificationService({
      botName: 'codexbot',
      workingDirectory: '/tmp/project',
      sessionsDir: '/tmp/codex/sessions',
      sessionIndexPath: '/tmp/codex/session_index.jsonl',
      socketPath: '/tmp/cli2im/codex-notify.sock',
      store: { bindNotificationTarget: vi.fn() } as unknown as SessionStore,
      resolveAdapter: () => undefined,
      timeZone: 'UTC',
      dependencies: {
        router: {
          resumePending: vi.fn(async () => { order.push('router.resume'); }),
          handle: vi.fn(),
          stop: vi.fn(() => { order.push('router.stop'); }),
        },
        metadataResolver: { resolve: vi.fn() },
        createSocket: () => ({
          start: vi.fn(async () => {
            order.push('socket.start');
            throw new Error('private socket detail');
          }),
          stop: vi.fn(async () => { order.push('socket.stop'); }),
        }),
        createMonitor: () => ({
          start: vi.fn(async () => { order.push('monitor.start'); }),
          stop: vi.fn(async () => {
            order.push('monitor.stop');
            throw new Error('private monitor detail');
          }),
        }),
      },
    });

    await expect(service.start()).resolves.toBeUndefined();
    await expect(service.stop()).resolves.toBeUndefined();

    expect(order).toEqual([
      'router.resume',
      'socket.start',
      'monitor.start',
      'monitor.stop',
      'socket.stop',
      'router.stop',
    ]);
    expect(consoleError).toHaveBeenNthCalledWith(1, '[notifications] socket start failed');
    expect(consoleError).toHaveBeenNthCalledWith(2, '[notifications] monitor stop failed');
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('private');
    consoleError.mockRestore();
  });
});
