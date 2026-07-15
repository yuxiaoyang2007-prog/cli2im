import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  eventKey,
  parseRolloutLine,
  type ParsedRolloutLine,
  type PermissionHookEvent,
} from '../src/notifications/codex-events.js';
import { CodexNotificationService } from '../src/notifications/service.js';
import type { NotificationMetadataResolver } from '../src/notifications/metadata.js';
import type { NotificationRouter } from '../src/notifications/router.js';
import type { SessionStore } from '../src/session/store.js';
import { startNotificationServiceBeforeReady } from '../src/index.js';

describe('CodexNotificationService', () => {
  it('starts and stops dependencies in order and routes stable question and completion events', async () => {
    const order: string[] = [];
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
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
    expect(consoleLog).toHaveBeenCalledWith(
      '[notifications] healthy router=ready socket=ready monitor=ready',
    );

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
    const completionTimestamp = '2026-07-15T18:35:18.250Z';
    const completion = parseRolloutLine(JSON.stringify({
      timestamp: completionTimestamp,
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'turn_1',
        completed_at: Date.parse('2026-07-15T18:35:18Z') / 1000,
        duration_ms: 1_000,
      },
    }));
    expect(completion).toMatchObject({
      occurredAt: Date.parse(completionTimestamp),
      durationMs: 1_000,
    });
    await onRollout?.(completion as ParsedRolloutLine, filePath);
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
      occurredAt: Date.parse(completionTimestamp),
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
    consoleLog.mockRestore();
  });

  it('preserves a queued question timestamp so delayed delivery uses event time', async () => {
    let onRollout: ((event: ParsedRolloutLine, filePath: string) => void | Promise<void>) | undefined;
    const eventTime = Date.parse('2026-07-15T14:32:10.250-04:00');
    const router = {
      resumePending: vi.fn(),
      handle: vi.fn().mockResolvedValue('delivered'),
      stop: vi.fn(),
    } as unknown as NotificationRouter;
    const service = new CodexNotificationService({
      botName: 'codexbot',
      workingDirectory: '/tmp/project',
      sessionsDir: '/tmp/codex/sessions',
      sessionIndexPath: '/tmp/codex/session_index.jsonl',
      socketPath: '/tmp/cli2im/codex-notify.sock',
      store: { bindNotificationTarget: vi.fn() } as unknown as SessionStore,
      resolveAdapter: () => undefined,
      timeZone: 'UTC',
      now: () => eventTime + 31_000,
      dependencies: {
        router,
        metadataResolver: {
          resolve: vi.fn().mockResolvedValue({
            projectName: 'cli2im', taskName: '排队问题', surface: 'CLI', shortTaskId: 'session_',
          }),
        },
        createMonitor: (handler) => {
          onRollout = handler;
          return { start: vi.fn(), stop: vi.fn() };
        },
        createSocket: () => ({ start: vi.fn(), stop: vi.fn() }),
      },
    });
    const filePath = '/tmp/codex/sessions/rollout-question-time.jsonl';

    await onRollout?.({ type: 'session_meta', sessionId: 'session_time', cwd: '/tmp/project', source: 'cli' }, filePath);
    await onRollout?.({ type: 'turn_context', turnId: 'turn_time', cwd: '/tmp/project' }, filePath);
    await onRollout?.({
      type: 'question', turnId: 'turn_time', requestId: 'question_time', occurredAt: eventTime,
    }, filePath);

    expect(router.handle).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'question_time',
      occurredAt: eventTime,
    }));
    expect(eventTime + 31_000 - vi.mocked(router.handle).mock.calls[0][0].occurredAt).toBeGreaterThan(30_000);
  });

  it('uses now only when a question timestamp is missing', async () => {
    let onRollout: ((event: ParsedRolloutLine, filePath: string) => void | Promise<void>) | undefined;
    const router = {
      resumePending: vi.fn(), handle: vi.fn().mockResolvedValue('delivered'), stop: vi.fn(),
    } as unknown as NotificationRouter;
    const service = new CodexNotificationService({
      botName: 'codexbot', workingDirectory: '/tmp/project', sessionsDir: '/tmp/codex/sessions',
      sessionIndexPath: '/tmp/codex/session_index.jsonl', socketPath: '/tmp/cli2im/codex-notify.sock',
      store: { bindNotificationTarget: vi.fn() } as unknown as SessionStore,
      resolveAdapter: () => undefined, timeZone: 'UTC', now: () => 44_000,
      dependencies: {
        router,
        metadataResolver: { resolve: vi.fn().mockResolvedValue({
          projectName: 'cli2im', taskName: '无时间问题', surface: 'CLI', shortTaskId: 'session_',
        }) },
        createMonitor: (handler) => {
          onRollout = handler;
          return { start: vi.fn(), stop: vi.fn() };
        },
        createSocket: () => ({ start: vi.fn(), stop: vi.fn() }),
      },
    });
    const filePath = '/tmp/codex/sessions/rollout-question-fallback.jsonl';

    await onRollout?.({ type: 'session_meta', sessionId: 'session_fallback', cwd: '/tmp/project', source: 'cli' }, filePath);
    await onRollout?.({ type: 'question', turnId: 'turn_fallback', requestId: 'question_fallback' }, filePath);

    expect(router.handle).toHaveBeenCalledWith(expect.objectContaining({ occurredAt: 44_000 }));
  });

  it('keeps the first valid user message metadata for a turn', async () => {
    let onRollout: ((event: ParsedRolloutLine, filePath: string) => void | Promise<void>) | undefined;
    const router = {
      resumePending: vi.fn(), handle: vi.fn().mockResolvedValue('delivered'), stop: vi.fn(),
    } as unknown as NotificationRouter;
    const metadataResolver = {
      resolve: vi.fn(async (input) => ({
        projectName: 'cli2im', taskName: input.userText || `处理文件：${input.attachmentName}`,
        surface: 'CLI' as const, shortTaskId: 'session_',
      })),
    } as unknown as NotificationMetadataResolver;
    const service = new CodexNotificationService({
      botName: 'codexbot', workingDirectory: '/tmp/project', sessionsDir: '/tmp/codex/sessions',
      sessionIndexPath: '/tmp/codex/session_index.jsonl', socketPath: '/tmp/cli2im/codex-notify.sock',
      store: { bindNotificationTarget: vi.fn() } as unknown as SessionStore,
      resolveAdapter: () => undefined, timeZone: 'UTC', now: () => 5_000,
      dependencies: {
        router, metadataResolver,
        createMonitor: (handler) => {
          onRollout = handler;
          return { start: vi.fn(), stop: vi.fn() };
        },
        createSocket: () => ({ start: vi.fn(), stop: vi.fn() }),
      },
    });
    const filePath = '/tmp/codex/sessions/rollout-first-message.jsonl';

    await onRollout?.({ type: 'session_meta', sessionId: 'session_first', cwd: '/tmp/project', source: 'cli' }, filePath);
    await onRollout?.({ type: 'user_message', turnId: 'turn_first', userText: '第一条任务' }, filePath);
    await onRollout?.({ type: 'user_message', turnId: 'turn_first', userText: '后续消息', attachmentName: 'later.pdf' }, filePath);
    await onRollout?.({ type: 'question', turnId: 'turn_first', requestId: 'question_first' }, filePath);

    expect(metadataResolver.resolve).toHaveBeenCalledWith(expect.objectContaining({
      userText: '第一条任务',
      attachmentName: undefined,
    }));
  });

  it('keeps a first attachment-only message ahead of later text', async () => {
    let onRollout: ((event: ParsedRolloutLine, filePath: string) => void | Promise<void>) | undefined;
    const router = {
      resumePending: vi.fn(), handle: vi.fn().mockResolvedValue('delivered'), stop: vi.fn(),
    } as unknown as NotificationRouter;
    const metadataResolver = {
      resolve: vi.fn(async (input) => ({
        projectName: 'cli2im', taskName: input.userText || `处理文件：${input.attachmentName}`,
        surface: 'CLI' as const, shortTaskId: 'session_',
      })),
    } as unknown as NotificationMetadataResolver;
    const service = new CodexNotificationService({
      botName: 'codexbot', workingDirectory: '/tmp/project', sessionsDir: '/tmp/codex/sessions',
      sessionIndexPath: '/tmp/codex/session_index.jsonl', socketPath: '/tmp/cli2im/codex-notify.sock',
      store: { bindNotificationTarget: vi.fn() } as unknown as SessionStore,
      resolveAdapter: () => undefined, timeZone: 'UTC', now: () => 5_000,
      dependencies: {
        router, metadataResolver,
        createMonitor: (handler) => {
          onRollout = handler;
          return { start: vi.fn(), stop: vi.fn() };
        },
        createSocket: () => ({ start: vi.fn(), stop: vi.fn() }),
      },
    });
    const filePath = '/tmp/codex/sessions/rollout-first-attachment.jsonl';

    await onRollout?.({ type: 'session_meta', sessionId: 'session_attach', cwd: '/tmp/project', source: 'cli' }, filePath);
    await onRollout?.({ type: 'user_message', turnId: 'turn_attach', attachmentName: 'first.pdf' }, filePath);
    await onRollout?.({ type: 'user_message', turnId: 'turn_attach', userText: '后续文本' }, filePath);
    await onRollout?.({ type: 'question', turnId: 'turn_attach', requestId: 'question_attach' }, filePath);

    expect(metadataResolver.resolve).toHaveBeenCalledWith(expect.objectContaining({
      userText: '',
      attachmentName: 'first.pdf',
    }));
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

  it.each([
    ['router', ['router.resume', 'router.stop']],
    ['socket', ['router.resume', 'socket.start', 'socket.stop', 'router.stop']],
    ['monitor', [
      'router.resume', 'socket.start', 'monitor.start',
      'monitor.stop', 'socket.stop', 'router.stop',
    ]],
  ] as const)('fails closed and rolls back a %s startup failure', async (failure, expectedOrder) => {
    const order: string[] = [];
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
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
          resumePending: vi.fn(async () => {
            order.push('router.resume');
            if (failure === 'router') throw new Error('private router detail');
          }),
          handle: vi.fn(),
          stop: vi.fn(async () => { order.push('router.stop'); }),
        },
        metadataResolver: { resolve: vi.fn() },
        createSocket: () => ({
          start: vi.fn(async () => {
            order.push('socket.start');
            if (failure === 'socket') throw new Error('private socket detail');
          }),
          stop: vi.fn(async () => { order.push('socket.stop'); }),
        }),
        createMonitor: () => ({
          start: vi.fn(async () => {
            order.push('monitor.start');
            if (failure === 'monitor') throw new Error('private monitor detail');
          }),
          stop: vi.fn(async () => { order.push('monitor.stop'); }),
        }),
      },
    });

    await expect(service.start()).rejects.toThrow('Codex notification service failed to start');

    expect(order).toEqual(expectedOrder);
    expect(consoleError).toHaveBeenCalledWith('[notifications] start failed');
    expect(consoleLog).not.toHaveBeenCalled();
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('private');
    consoleError.mockRestore();
    consoleLog.mockRestore();
  });

  it('does not print generic Ready when enabled notification startup rejects', async () => {
    const ready = vi.fn();
    const service = {
      start: vi.fn().mockRejectedValue(new Error('notification startup failed')),
    };

    await expect(startNotificationServiceBeforeReady(service, ready)).rejects.toThrow(
      'notification startup failed',
    );

    expect(ready).not.toHaveBeenCalled();
  });

  it('awaits router shutdown before resolving service shutdown', async () => {
    const routerStop = deferred<void>();
    const order: string[] = [];
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
          resumePending: vi.fn(),
          handle: vi.fn(),
          stop: vi.fn(async () => {
            order.push('router.stop.start');
            await routerStop.promise;
            order.push('router.stop.end');
          }),
        },
        metadataResolver: { resolve: vi.fn() },
        createMonitor: () => ({
          start: vi.fn(),
          stop: vi.fn(async () => { order.push('monitor.stop'); }),
        }),
        createSocket: () => ({
          start: vi.fn(),
          stop: vi.fn(async () => { order.push('socket.stop'); }),
        }),
      },
    });

    let resolved = false;
    const stopping = service.stop().then(() => { resolved = true; });
    await vi.waitFor(() => expect(order).toEqual([
      'monitor.stop',
      'socket.stop',
      'router.stop.start',
    ]));
    expect(resolved).toBe(false);

    routerStop.resolve();
    await stopping;
    expect(order).toEqual([
      'monitor.stop',
      'socket.stop',
      'router.stop.start',
      'router.stop.end',
    ]);
  });

  it('hydrates persisted rollout context when approval is the first event after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cli2im-approval-context-'));
    try {
      const codexDir = join(directory, 'codex');
      const sessionsDir = join(codexDir, 'sessions', '2026', '07', '15');
      const projectDir = join(directory, 'different-project');
      const fallbackDir = join(directory, 'fallback-project');
      const sessionId = 'session_approval_first';
      const turnId = 'turn_approval_first';
      await Promise.all([
        mkdir(sessionsDir, { recursive: true }),
        mkdir(projectDir, { recursive: true }),
        mkdir(fallbackDir, { recursive: true }),
      ]);
      await writeFile(join(
        sessionsDir,
        `rollout-2026-07-15T12-00-00-${sessionId}.jsonl`,
      ), [
        JSON.stringify({
          type: 'session_meta',
          payload: { id: sessionId, cwd: projectDir, source: 'cli' },
        }),
        JSON.stringify({
          type: 'turn_context',
          payload: { turn_id: turnId, cwd: projectDir },
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: { type: 'task_complete', turn_id: 'historical_turn', completed_at: 1_000 },
        }),
      ].join('\n') + '\n');
      await writeFile(join(codexDir, 'session_index.jsonl'), `${JSON.stringify({
        id: sessionId,
        thread_name: '审批首次事件',
      })}\n`);

      let onApproval: ((event: PermissionHookEvent) => void | Promise<void>) | undefined;
      const router = {
        resumePending: vi.fn().mockResolvedValue(undefined),
        handle: vi.fn().mockResolvedValue('delivered'),
        stop: vi.fn(),
      } as unknown as NotificationRouter;
      const service = new CodexNotificationService({
        botName: 'codexbot',
        workingDirectory: fallbackDir,
        sessionsDir: join(codexDir, 'sessions'),
        sessionIndexPath: join(codexDir, 'session_index.jsonl'),
        socketPath: join(directory, 'notify.sock'),
        store: { bindNotificationTarget: vi.fn() } as unknown as SessionStore,
        resolveAdapter: () => undefined,
        timeZone: 'UTC',
        dependencies: {
          router,
          createMonitor: () => ({ start: vi.fn(), stop: vi.fn() }),
          createSocket: (handler) => {
            onApproval = handler;
            return { start: vi.fn(), stop: vi.fn() };
          },
        },
      });

      const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      await service.start();
      consoleLog.mockRestore();
      await onApproval?.({
        type: 'approval',
        sessionId,
        turnId,
        requestId: 'approval_first',
        occurredAt: 2_000,
      });

      expect(router.handle).toHaveBeenCalledTimes(1);
      expect(router.handle).toHaveBeenCalledWith(expect.objectContaining({
        eventKey: eventKey([sessionId, turnId, 'approval_first', 'approval']),
        kind: 'needs_attention',
        reason: 'approval',
        projectName: 'different-project',
        taskName: '审批首次事件',
        surface: 'CLI',
      }));
      expect(JSON.stringify(vi.mocked(router.handle).mock.calls)).not.toContain(projectDir);
      expect(JSON.stringify(vi.mocked(router.handle).mock.calls)).not.toContain('historical_turn');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('releases completed context and rehydrates a later active turn without replay', async () => {
    let onRollout: ((event: ParsedRolloutLine, filePath: string) => void | Promise<void>) | undefined;
    const router = {
      resumePending: vi.fn().mockResolvedValue(undefined),
      handle: vi.fn().mockResolvedValue('delivered'),
      stop: vi.fn(),
    } as unknown as NotificationRouter;
    const metadataResolver = {
      resolve: vi.fn(async (input) => ({
        projectName: 'project',
        taskName: input.userText || 'unnamed',
        surface: 'CLI' as const,
        shortTaskId: 'session_',
      })),
    } as unknown as NotificationMetadataResolver;
    const readContextFile = vi.fn().mockResolvedValue([
      JSON.stringify({
        type: 'session_meta',
        payload: { id: 'session_release', cwd: '/tmp/project', source: 'cli' },
      }),
      JSON.stringify({
        type: 'turn_context',
        payload: { turn_id: 'turn_2', cwd: '/tmp/project' },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '第二轮任务' }],
          internal_chat_message_metadata_passthrough: { turn_id: 'turn_2' },
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'turn_1', completed_at: 1_000 },
      }),
    ].join('\n'));
    const filePath = '/tmp/codex/sessions/rollout-release.jsonl';
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
        readContextFile,
      },
    });

    await onRollout?.({
      type: 'session_meta',
      sessionId: 'session_release',
      cwd: '/tmp/project',
      source: 'cli',
    }, filePath);
    await onRollout?.({ type: 'turn_context', turnId: 'turn_1', cwd: '/tmp/project' }, filePath);
    await onRollout?.({ type: 'user_message', turnId: 'turn_1', userText: '第一轮任务' }, filePath);
    await onRollout?.({ type: 'completed', turnId: 'turn_1', occurredAt: 1_000 }, filePath);
    await onRollout?.({ type: 'question', turnId: 'turn_2', requestId: 'question_2' }, filePath);

    expect(readContextFile).toHaveBeenCalledTimes(1);
    expect(metadataResolver.resolve).toHaveBeenLastCalledWith({
      sessionId: 'session_release',
      cwd: '/tmp/project',
      source: 'cli',
      userText: '第二轮任务',
      attachmentName: undefined,
    });
    expect(router.handle).toHaveBeenCalledTimes(2);
    expect(router.handle).toHaveBeenLastCalledWith(expect.objectContaining({
      eventKey: eventKey(['session_release', 'turn_2', 'question_2', 'question']),
      taskName: '第二轮任务',
    }));
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
