import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
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
import { SessionStore } from '../src/session/store.js';
import { startNotificationServiceBeforeReady } from '../src/index.js';
import type { PlatformAdapter } from '../src/types.js';
import { FeishuAdapter } from '../src/platforms/feishu/adapter.js';

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

  it('routes an implicit final-answer choice as attention instead of completion', async () => {
    let onRollout: ((event: ParsedRolloutLine, filePath: string) => void | Promise<void>) | undefined;
    const router = {
      resumePending: vi.fn(),
      handle: vi.fn().mockResolvedValue('delivered'),
      stop: vi.fn(),
    } as unknown as NotificationRouter;
    const metadataResolver = {
      resolve: vi.fn(async () => ({
        projectName: 'power-trader-edu',
        taskName: '生成宣传讲解 HTML PPT',
        surface: 'Codex Desktop' as const,
        shortTaskId: 'session_',
      })),
    } as unknown as NotificationMetadataResolver;
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
        router,
        metadataResolver,
        createMonitor: (handler) => {
          onRollout = handler;
          return { start: vi.fn(), stop: vi.fn() };
        },
        createSocket: () => ({ start: vi.fn(), stop: vi.fn() }),
        readContextFile: vi.fn().mockResolvedValue(''),
      },
    });
    const filePath = '/tmp/codex/sessions/rollout-choice.jsonl';

    await onRollout?.({
      type: 'session_meta', sessionId: 'session_choice', cwd: '/tmp/project', source: 'codex-desktop',
    }, filePath);
    await onRollout?.({ type: 'turn_context', turnId: 'turn_choice', cwd: '/tmp/project' }, filePath);
    await onRollout?.({
      type: 'user_message', turnId: 'turn_choice', userText: '生成宣传讲解 HTML PPT',
    }, filePath);
    await onRollout?.({
      type: 'assistant_state', turnId: 'turn_choice', awaitingUser: true,
    }, filePath);
    await onRollout?.({
      type: 'completed', turnId: 'turn_choice', occurredAt: 5_000,
    }, filePath);

    expect(router.handle).toHaveBeenCalledTimes(1);
    expect(router.handle).toHaveBeenCalledWith(expect.objectContaining({
      eventKey: eventKey(['session_choice', 'turn_choice', 'implicit-question']),
      kind: 'needs_attention',
      reason: 'question',
      projectName: 'power-trader-edu',
      taskName: '生成宣传讲解 HTML PPT',
      occurredAt: 5_000,
    }));
    expect(router.handle).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'completed' }));
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

  it('associates a no-id question only with the single active turn_context', async () => {
    let onRollout: ((event: ParsedRolloutLine, filePath: string) => void | Promise<void>) | undefined;
    const router = {
      resumePending: vi.fn(), handle: vi.fn().mockResolvedValue('delivered'), stop: vi.fn(),
    } as unknown as NotificationRouter;
    const service = new CodexNotificationService({
      botName: 'codexbot', workingDirectory: '/tmp/project', sessionsDir: '/tmp/codex/sessions',
      sessionIndexPath: '/tmp/codex/session_index.jsonl', socketPath: '/tmp/cli2im/codex-notify.sock',
      store: { bindNotificationTarget: vi.fn() } as unknown as SessionStore,
      resolveAdapter: () => undefined, timeZone: 'UTC', now: () => 55_000,
      dependencies: {
        router,
        metadataResolver: { resolve: vi.fn().mockResolvedValue({
          projectName: 'cli2im', taskName: '唯一活跃轮次', surface: 'CLI', shortTaskId: 'session_',
        }) },
        createMonitor: (handler) => {
          onRollout = handler;
          return { start: vi.fn(), stop: vi.fn() };
        },
        createSocket: () => ({ start: vi.fn(), stop: vi.fn() }),
      },
    });
    const filePath = '/tmp/codex/sessions/rollout-no-id-active.jsonl';
    const noIdQuestion = parseRolloutLine(JSON.stringify({
      timestamp: '2026-07-15T18:32:10.250Z',
      type: 'response_item',
      payload: {
        type: 'function_call', name: 'request_user_input', call_id: 'question_no_id',
        arguments: '{"questions":[{"question":"private active secret"}]}',
      },
    }));

    await onRollout?.({
      type: 'session_meta', sessionId: 'session_no_id', cwd: '/tmp/project', source: 'cli',
    }, filePath);
    await onRollout?.({ type: 'turn_context', turnId: 'turn_only', cwd: '/tmp/project' }, filePath);
    await onRollout?.({ type: 'user_message', turnId: 'turn_only', userText: '唯一活跃轮次' }, filePath);
    if (noIdQuestion) await onRollout?.(noIdQuestion, filePath);

    expect(router.handle).toHaveBeenCalledWith(expect.objectContaining({
      eventKey: eventKey(['session_no_id', 'turn_only', 'question_no_id', 'question']),
      turnId: 'turn_only',
      requestId: 'question_no_id',
      occurredAt: Date.parse('2026-07-15T18:32:10.250Z'),
    }));
    expect(JSON.stringify(vi.mocked(router.handle).mock.calls)).not.toContain('private active secret');
  });

  it('does not trust a bounded restart window for no-id association, then trusts a live turn_context', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cli2im-no-id-window-'));
    try {
      const filePath = join(directory, 'rollout-large.jsonl');
      const sessionId = 'session_large_window';
      const historical = [
        JSON.stringify({
          type: 'session_meta', payload: { id: sessionId, cwd: '/tmp/project', source: 'cli' },
        }),
        JSON.stringify({
          type: 'turn_context', payload: { turn_id: 'turn_old_head', cwd: '/tmp/project' },
        }),
      ].join('\n');
      const omittedMiddle = [
        JSON.stringify({
          type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'turn_old_head' },
        }),
        JSON.stringify({
          type: 'turn_context', payload: { turn_id: 'turn_current_middle', cwd: '/tmp/project' },
        }),
      ].join('\n');
      const noIdLine = JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call', name: 'request_user_input', call_id: 'question_tail_no_id',
          arguments: '{"questions":[{"question":"private tail question"}]}',
        },
      });
      await writeFile(filePath, [
        historical,
        'x'.repeat(40_000),
        omittedMiddle,
        'y'.repeat(40_000),
        noIdLine,
      ].join('\n'));

      let onRollout: ((event: ParsedRolloutLine, filePath: string) => void | Promise<void>) | undefined;
      const router = {
        resumePending: vi.fn(), handle: vi.fn().mockResolvedValue('delivered'), stop: vi.fn(),
      } as unknown as NotificationRouter;
      const service = new CodexNotificationService({
        botName: 'codexbot', workingDirectory: '/tmp/project', sessionsDir: directory,
        sessionIndexPath: join(directory, 'session_index.jsonl'), socketPath: join(directory, 'notify.sock'),
        store: { bindNotificationTarget: vi.fn() } as unknown as SessionStore,
        resolveAdapter: () => undefined, timeZone: 'UTC',
        dependencies: {
          router,
          metadataResolver: { resolve: vi.fn().mockResolvedValue({
            projectName: 'cli2im', taskName: '窗口信任测试', surface: 'CLI', shortTaskId: 'session_',
          }) },
          createMonitor: (handler) => {
            onRollout = handler;
            return { start: vi.fn(), stop: vi.fn() };
          },
          createSocket: () => ({ start: vi.fn(), stop: vi.fn() }),
        },
      });
      const noIdQuestion = parseRolloutLine(noIdLine);
      expect(noIdQuestion).toMatchObject({ type: 'question', requestId: 'question_tail_no_id' });

      await onRollout?.(noIdQuestion as ParsedRolloutLine, filePath);
      expect(router.handle).not.toHaveBeenCalled();

      await onRollout?.({
        type: 'turn_context', turnId: 'turn_live_observed', cwd: '/tmp/project',
      }, filePath);
      await onRollout?.(noIdQuestion as ParsedRolloutLine, filePath);

      expect(router.handle).toHaveBeenCalledTimes(1);
      expect(router.handle).toHaveBeenCalledWith(expect.objectContaining({
        eventKey: eventKey([sessionId, 'turn_live_observed', 'question_tail_no_id', 'question']),
        turnId: 'turn_live_observed',
      }));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reconstructs cursorless startup context gap-free while notifying only the current unambiguous no-id question', async () => {
    vi.useRealTimers();
    const directory = await mkdtemp(join(tmpdir(), 'cli2im-cursorless-catchup-'));
    const sessionsDir = join(directory, 'sessions');
    const validFile = join(sessionsDir, 'rollout-valid-catchup.jsonl');
    const ambiguousFile = join(sessionsDir, 'rollout-ambiguous-catchup.jsonl');
    const now = Date.now();
    const oldTimestamp = now - 60_000;
    const currentTimestamp = now + 60_000;
    let service: CodexNotificationService | undefined;
    let restartedService: CodexNotificationService | undefined;
    let store: SessionStore | undefined;
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await mkdir(sessionsDir, { recursive: true });
      await Promise.all([
        writeFile(validFile, startupCatchupRollout({
          sessionId: 'session_valid_catchup',
          currentTurnIds: ['turn_current_valid'],
          currentTask: 'Implement Feishu notifications',
          oldTimestamp,
          currentTimestamp,
          requestId: 'question_current_valid',
        })),
        writeFile(ambiguousFile, startupCatchupRollout({
          sessionId: 'session_ambiguous_catchup',
          currentTurnIds: ['turn_current_first', 'turn_current_second'],
          currentTask: 'Review ambiguous notification',
          oldTimestamp,
          currentTimestamp,
          requestId: 'question_current_ambiguous',
        })),
      ]);
      const future = new Date(currentTimestamp);
      await Promise.all([
        utimes(validFile, future, future),
        utimes(ambiguousFile, future, future),
      ]);
      store = await SessionStore.create(':memory:');
      const router = {
        resumePending: vi.fn().mockResolvedValue(undefined),
        handle: vi.fn().mockResolvedValue('delivered'),
        stop: vi.fn().mockResolvedValue(undefined),
      } as unknown as NotificationRouter;
      const dependencies = {
        router,
        metadataResolver: {
          resolve: vi.fn(async (input) => ({
            projectName: 'startup-project',
            taskName: input.userText || 'unnamed',
            surface: 'CLI' as const,
            shortTaskId: input.sessionId.slice(0, 8),
          })),
        },
        createSocket: () => ({ start: vi.fn(), stop: vi.fn() }),
      };
      const options = {
        botName: 'codexbot',
        workingDirectory: directory,
        sessionsDir,
        sessionIndexPath: join(directory, 'session_index.jsonl'),
        socketPath: join(directory, 'notify.sock'),
        store,
        resolveAdapter: () => undefined,
        timeZone: 'UTC',
        dependencies,
      };

      service = new CodexNotificationService(options);
      await service.start();

      expect(router.handle).toHaveBeenCalledTimes(1);
      expect(router.handle).toHaveBeenCalledWith(expect.objectContaining({
        eventKey: eventKey([
          'session_valid_catchup',
          'turn_current_valid',
          'question_current_valid',
          'question',
        ]),
        sessionId: 'session_valid_catchup',
        turnId: 'turn_current_valid',
        requestId: 'question_current_valid',
        projectName: 'startup-project',
        taskName: 'Implement Feishu notifications',
      }));
      expect(JSON.stringify(vi.mocked(router.handle).mock.calls)).not.toContain('old_question');
      expect(JSON.stringify(vi.mocked(router.handle).mock.calls)).not.toContain('question_current_ambiguous');
      expect((await store.getNotificationCursor(validFile))?.byteOffset).toBe((await stat(validFile)).size);
      expect((await store.getNotificationCursor(ambiguousFile))?.byteOffset).toBe((await stat(ambiguousFile)).size);

      await service.stop();
      service = undefined;
      restartedService = new CodexNotificationService(options);
      await restartedService.start();
      expect(router.handle).toHaveBeenCalledTimes(1);
    } finally {
      await restartedService?.stop();
      await service?.stop();
      store?.close();
      consoleLog.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ['completed', 'task_complete'],
    ['aborted', 'turn_aborted'],
  ] as const)(
    'preserves gap-free startup identity after a historical %s turn until the current terminal event',
    async (historicalKind, historicalEventType) => {
      vi.useRealTimers();
      const directory = await mkdtemp(join(tmpdir(), `cli2im-catchup-${historicalKind}-`));
      const sessionsDir = join(directory, 'sessions');
      const filePath = join(sessionsDir, `rollout-${historicalKind}-terminal.jsonl`);
      const sessionId = `session_${historicalKind}_terminal`;
      const currentTurnId = `turn_current_${historicalKind}`;
      const requestId = `question_current_${historicalKind}`;
      const now = Date.now();
      const oldTimestamp = now - 60_000;
      const currentTimestamp = now + 60_000;
      const rollout = startupTerminalCatchupRollout({
        sessionId,
        currentTurnId,
        currentTask: 'Ship Feishu startup notifications',
        historicalEventType,
        oldTimestamp,
        currentTimestamp,
        requestId,
      });
      let service: CodexNotificationService | undefined;
      let store: SessionStore | undefined;
      const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

      try {
        expect(Buffer.byteLength(rollout.slice(0, rollout.indexOf('\n')))).toBeGreaterThan(22 * 1024);
        await mkdir(sessionsDir, { recursive: true });
        await writeFile(filePath, rollout);
        const future = new Date(currentTimestamp);
        await utimes(filePath, future, future);
        store = await SessionStore.create(':memory:');
        const router = {
          resumePending: vi.fn().mockResolvedValue(undefined),
          handle: vi.fn().mockResolvedValue('delivered'),
          stop: vi.fn().mockResolvedValue(undefined),
        } as unknown as NotificationRouter;
        service = new CodexNotificationService({
          botName: 'codexbot',
          workingDirectory: directory,
          sessionsDir,
          sessionIndexPath: join(directory, 'session_index.jsonl'),
          socketPath: join(directory, 'notify.sock'),
          store,
          resolveAdapter: () => undefined,
          timeZone: 'UTC',
          dependencies: {
            router,
            metadataResolver: {
              resolve: vi.fn(async (input) => ({
                projectName: input.cwd === '/tmp/startup-project'
                  ? 'startup-project'
                  : 'wrong-project',
                taskName: input.userText || 'unnamed',
                surface: 'CLI' as const,
                shortTaskId: input.sessionId.slice(0, 8),
              })),
            },
            createSocket: () => ({ start: vi.fn(), stop: vi.fn() }),
          },
        });

        await service.start();

        expect(router.handle).toHaveBeenCalledTimes(2);
        expect(router.handle).toHaveBeenNthCalledWith(1, expect.objectContaining({
          eventKey: eventKey([sessionId, currentTurnId, requestId, 'question']),
          kind: 'needs_attention',
          reason: 'question',
          sessionId,
          turnId: currentTurnId,
          requestId,
          projectName: 'startup-project',
          taskName: 'Ship Feishu startup notifications',
        }));
        expect(router.handle).toHaveBeenNthCalledWith(2, expect.objectContaining({
          eventKey: eventKey([sessionId, currentTurnId, 'completed']),
          kind: 'completed',
          sessionId,
          turnId: currentTurnId,
          projectName: 'startup-project',
          taskName: 'Ship Feishu startup notifications',
        }));
        const routed = JSON.stringify(vi.mocked(router.handle).mock.calls);
        expect(routed).not.toContain('historical_turn');
        expect((await store.getNotificationCursor(filePath))?.byteOffset).toBe((await stat(filePath)).size);
        const retained = service as unknown as {
          contextsByFile: Map<string, unknown>;
          contextsBySession: Map<string, unknown>;
        };
        expect(retained.contextsByFile.size).toBe(0);
        expect(retained.contextsBySession.size).toBe(0);
      } finally {
        await service?.stop();
        store?.close();
        consoleLog.mockRestore();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ['no active context', []],
    ['ambiguous active contexts', [
      { type: 'turn_context', turnId: 'turn_first', cwd: '/tmp/project' },
      { type: 'turn_context', turnId: 'turn_second', cwd: '/tmp/project' },
    ]],
    ['an aborted context', [
      { type: 'turn_context', turnId: 'turn_aborted', cwd: '/tmp/project' },
      { type: 'aborted', turnId: 'turn_aborted' },
    ]],
    ['a completed context', [
      { type: 'turn_context', turnId: 'turn_completed', cwd: '/tmp/project' },
      { type: 'completed', turnId: 'turn_completed', occurredAt: 1_000 },
    ]],
  ] as const)('drops a no-id question with %s', async (_label, contextEvents) => {
    let onRollout: ((event: ParsedRolloutLine, filePath: string) => void | Promise<void>) | undefined;
    const router = {
      resumePending: vi.fn(), handle: vi.fn().mockResolvedValue('delivered'), stop: vi.fn(),
    } as unknown as NotificationRouter;
    const service = new CodexNotificationService({
      botName: 'codexbot', workingDirectory: '/tmp/project', sessionsDir: '/tmp/codex/sessions',
      sessionIndexPath: '/tmp/codex/session_index.jsonl', socketPath: '/tmp/cli2im/codex-notify.sock',
      store: { bindNotificationTarget: vi.fn() } as unknown as SessionStore,
      resolveAdapter: () => undefined, timeZone: 'UTC',
      dependencies: {
        router,
        metadataResolver: { resolve: vi.fn() },
        createMonitor: (handler) => {
          onRollout = handler;
          return { start: vi.fn(), stop: vi.fn() };
        },
        createSocket: () => ({ start: vi.fn(), stop: vi.fn() }),
      },
    });
    const filePath = `/tmp/codex/sessions/rollout-no-id-${_label}.jsonl`;
    await onRollout?.({
      type: 'session_meta', sessionId: `session_${_label}`, cwd: '/tmp/project', source: 'cli',
    }, filePath);
    for (const contextEvent of contextEvents) {
      await onRollout?.(contextEvent as ParsedRolloutLine, filePath);
    }
    const question = parseRolloutLine(JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'function_call', name: 'request_user_input', call_id: 'question_no_id_drop',
        arguments: '{"questions":[{"question":"private dropped secret"}]}',
      },
    }));
    if (question) await onRollout?.(question, filePath);

    expect(router.handle).not.toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'question_no_id_drop',
    }));
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

  it('restores context when a rollout session metadata line exceeds the generic head window', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cli2im-large-session-meta-'));
    const filePath = join(directory, 'rollout-large-session-meta.jsonl');
    let onRollout: ((event: ParsedRolloutLine, filePath: string) => void | Promise<void>) | undefined;
    const router = {
      resumePending: vi.fn().mockResolvedValue(undefined),
      handle: vi.fn().mockResolvedValue('delivered'),
      stop: vi.fn(),
    } as unknown as NotificationRouter;
    const metadataResolver = {
      resolve: vi.fn(async () => ({
        projectName: 'power-trader-edu',
        taskName: '生成宣传讲解 HTML PPT',
        surface: 'Codex Desktop' as const,
        shortTaskId: 'session_',
      })),
    } as unknown as NotificationMetadataResolver;
    const lines = [
      JSON.stringify({
        type: 'session_meta',
        payload: {
          id: 'session_large_meta',
          cwd: '/tmp/power-trader-edu',
          source: 'codex-desktop',
          padding: 'x'.repeat(40_000),
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'token_count', padding: 'x'.repeat(260_000) },
      }),
      JSON.stringify({
        type: 'turn_context',
        payload: { turn_id: 'turn_large_meta', cwd: '/tmp/power-trader-edu' },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '生成宣传讲解 HTML PPT' }],
          internal_chat_message_metadata_passthrough: { turn_id: 'turn_large_meta' },
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'token_count', padding: 'x'.repeat(50_000) },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'final_answer',
          content: [{ type: 'output_text', text: '确认按方案一执行吗？' }],
          internal_chat_message_metadata_passthrough: { turn_id: 'turn_large_meta' },
        },
      }),
      JSON.stringify({
        timestamp: '2026-07-16T07:45:29.499Z',
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'turn_large_meta' },
      }),
    ];

    try {
      await writeFile(filePath, `${lines.join('\n')}\n`);
      new CodexNotificationService({
        botName: 'codexbot',
        workingDirectory: '/tmp/fallback',
        sessionsDir: directory,
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
        },
      });

      await onRollout?.({
        type: 'completed', turnId: 'turn_large_meta', occurredAt: 5_000,
      }, filePath);

      expect(router.handle).toHaveBeenCalledWith(expect.objectContaining({
        eventKey: eventKey(['session_large_meta', 'turn_large_meta', 'implicit-question']),
        kind: 'needs_attention',
        reason: 'question',
        projectName: 'power-trader-edu',
        taskName: '生成宣传讲解 HTML PPT',
      }));
      expect(metadataResolver.resolve).toHaveBeenCalledWith({
        sessionId: 'session_large_meta',
        cwd: '/tmp/power-trader-edu',
        source: 'codex-desktop',
        userText: '生成宣传讲解 HTML PPT',
        attachmentName: undefined,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('uses the last meaningful user task for an automatic continuation turn', async () => {
    let onRollout: ((event: ParsedRolloutLine, filePath: string) => void | Promise<void>) | undefined;
    const router = {
      resumePending: vi.fn(),
      handle: vi.fn().mockResolvedValue('delivered'),
      stop: vi.fn(),
    } as unknown as NotificationRouter;
    const metadataResolver = {
      resolve: vi.fn(async () => ({
        projectName: 'content-project',
        taskName: '输出内容固定到统一文件夹并写入 skill',
        surface: 'Codex Desktop' as const,
        shortTaskId: 'session_',
      })),
    } as unknown as NotificationMetadataResolver;
    const historicalContext = [
      JSON.stringify({
        type: 'session_meta',
        payload: { id: 'session_continuation', cwd: '/tmp/original', source: 'codex-desktop' },
      }),
      JSON.stringify({
        type: 'turn_context',
        payload: { turn_id: 'turn_user', cwd: '/tmp/content-project' },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '输出内容固定到统一文件夹并写入 skill' }],
          internal_chat_message_metadata_passthrough: { turn_id: 'turn_user' },
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'turn_user' },
      }),
      JSON.stringify({
        type: 'turn_context',
        payload: { turn_id: 'turn_continuation', cwd: '/tmp/content-project' },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'final_answer',
          content: [{ type: 'output_text', text: '已持久化并完成验证。' }],
          internal_chat_message_metadata_passthrough: { turn_id: 'turn_continuation' },
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
      type: 'completed', turnId: 'turn_continuation', occurredAt: 5_000,
    }, '/tmp/codex/sessions/rollout-continuation.jsonl');

    expect(metadataResolver.resolve).toHaveBeenCalledWith({
      sessionId: 'session_continuation',
      cwd: '/tmp/content-project',
      source: 'codex-desktop',
      userText: '输出内容固定到统一文件夹并写入 skill',
      attachmentName: undefined,
    });
    expect(router.handle).toHaveBeenCalledWith(expect.objectContaining({
      eventKey: eventKey(['session_continuation', 'turn_continuation', 'completed']),
      kind: 'completed',
      projectName: 'content-project',
      taskName: '输出内容固定到统一文件夹并写入 skill',
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

  it('aborts a callback-blocked router concurrently when monitor startup fails', async () => {
    vi.useRealTimers();
    const routerStopGate = deferred<void>();
    let activeSocketCallback: Promise<void> | undefined;
    const router = {
      resumePending: vi.fn(),
      handle: vi.fn(async () => { await routerStopGate.promise; return 'pending'; }),
      stop: vi.fn(() => { routerStopGate.resolve(); }),
    } as unknown as NotificationRouter;
    const socketStop = vi.fn(async () => { await activeSocketCallback; });
    const monitorStop = vi.fn();
    const service = new CodexNotificationService({
      botName: 'codexbot', workingDirectory: '/tmp/project', sessionsDir: '/tmp/codex/sessions',
      sessionIndexPath: '/tmp/codex/session_index.jsonl', socketPath: '/tmp/cli2im/codex-notify.sock',
      store: { bindNotificationTarget: vi.fn() } as unknown as SessionStore,
      resolveAdapter: () => undefined, timeZone: 'UTC',
      dependencies: {
        router,
        metadataResolver: { resolve: vi.fn().mockResolvedValue({
          projectName: 'cli2im', taskName: '启动回滚', surface: 'CLI', shortTaskId: 'session_',
        }) },
        findContextFile: vi.fn().mockResolvedValue(undefined),
        createSocket: (handler) => ({
          start: vi.fn(async () => {
            activeSocketCallback = Promise.resolve(handler({
              type: 'approval', sessionId: 'session_start_fail', turnId: 'turn_start_fail',
              requestId: 'approval_start_fail', occurredAt: 1,
            })).then(() => undefined);
          }),
          stop: socketStop,
        }),
        createMonitor: () => ({
          start: vi.fn(async () => { throw new Error('private monitor start failure'); }),
          stop: monitorStop,
        }),
      },
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const starting = service.start();
    const outcome = await Promise.race([
      starting.then(() => 'resolved' as const, () => 'rejected' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 100)),
    ]);
    if (outcome === 'timeout') {
      routerStopGate.resolve();
      await starting.catch(() => undefined);
    }

    expect(outcome).toBe('rejected');
    expect(router.stop).toHaveBeenCalledTimes(1);
    expect(socketStop).toHaveBeenCalledTimes(1);
    expect(monitorStop).toHaveBeenCalledTimes(1);
    await expect(service.stop()).resolves.toBeUndefined();
    expect(router.stop).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('private monitor start failure');
    consoleError.mockRestore();
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

  it('aborts a stalled adapter send before producer callback drain and stops idempotently', async () => {
    vi.useRealTimers();
    const store = await SessionStore.create(':memory:');
    await store.bindNotificationTarget({
      botName: 'codexbot', platform: 'feishu', chatId: 'oc_private', userId: 'ou_allowed', updatedAt: 1,
    });
    let onRollout: ((event: ParsedRolloutLine, filePath: string) => void | Promise<void>) | undefined;
    let activeCallback: Promise<void> | undefined;
    let abortSignal: AbortSignal | undefined;
    const cleanupSend = deferred<void>();
    const send = vi.fn<PlatformAdapter['send']>(async (_chatId, _content, options) => {
      abortSignal = options?.signal;
      await new Promise<void>((resolve, reject) => {
        const signal = options?.signal;
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        void cleanupSend.promise.then(resolve, reject);
      });
      return 'om_never_delivered';
    });
    const adapter = {
      name: 'feishu', connect: vi.fn(), disconnect: vi.fn(), onMessage: vi.fn(),
      send, editMessage: vi.fn(), deleteMessage: vi.fn(), replaceCard: vi.fn(),
    } as unknown as PlatformAdapter;
    const monitorStop = vi.fn(async () => { await activeCallback; });
    const socketStop = vi.fn();
    const service = new CodexNotificationService({
      botName: 'codexbot', workingDirectory: '/tmp/project', sessionsDir: '/tmp/codex/sessions',
      sessionIndexPath: '/tmp/codex/session_index.jsonl', socketPath: '/tmp/cli2im/codex-notify.sock',
      store, resolveAdapter: () => adapter, timeZone: 'UTC',
      dependencies: {
        metadataResolver: { resolve: vi.fn().mockResolvedValue({
          projectName: 'cli2im', taskName: '停机测试', surface: 'CLI', shortTaskId: 'session_',
        }) },
        createMonitor: (handler) => {
          onRollout = handler;
          return { start: vi.fn(), stop: monitorStop };
        },
        createSocket: () => ({ start: vi.fn(), stop: socketStop }),
      },
    });
    const filePath = '/tmp/codex/sessions/rollout-shutdown.jsonl';
    await onRollout?.({
      type: 'session_meta', sessionId: 'session_shutdown', cwd: '/tmp/project', source: 'cli',
    }, filePath);
    await onRollout?.({ type: 'turn_context', turnId: 'turn_shutdown', cwd: '/tmp/project' }, filePath);
    activeCallback = Promise.resolve(onRollout?.({
      type: 'question', turnId: 'turn_shutdown', requestId: 'question_shutdown', occurredAt: 10,
    }, filePath)).then(() => undefined);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    const stopping = service.stop();
    const secondStop = service.stop();
    const outcome = await Promise.race([
      Promise.all([stopping, secondStop]).then(() => 'stopped' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 100)),
    ]);
    if (outcome === 'timeout') {
      cleanupSend.resolve();
      await Promise.all([stopping, secondStop]);
    }

    expect(outcome).toBe('stopped');
    expect(abortSignal?.aborted).toBe(true);
    expect(monitorStop).toHaveBeenCalledTimes(1);
    expect(socketStop).toHaveBeenCalledTimes(1);
    expect(await store.listPendingNotifications()).toHaveLength(1);

    store.close();
    await expect(onRollout?.({
      type: 'question', turnId: 'turn_shutdown', requestId: 'late_question', occurredAt: 20,
    }, filePath)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('stops with a production Feishu adapter whose generated SDK create promise never settles', async () => {
    vi.useRealTimers();
    const store = await SessionStore.create(':memory:');
    await store.bindNotificationTarget({
      botName: 'codexbot', platform: 'feishu', chatId: 'oc_private', userId: 'ou_allowed', updatedAt: 1,
    });
    const adapter = new FeishuAdapter({ appId: 'app', appSecret: 'secret', botName: 'codexbot' });
    const sdkResult = deferred<unknown>();
    const sdkCreate = vi.spyOn(adapter.getClient().im.message, 'create')
      .mockReturnValue(sdkResult.promise as never);
    let onRollout: ((event: ParsedRolloutLine, filePath: string) => void | Promise<void>) | undefined;
    let activeCallback: Promise<void> | undefined;
    const service = new CodexNotificationService({
      botName: 'codexbot', workingDirectory: '/tmp/project', sessionsDir: '/tmp/codex/sessions',
      sessionIndexPath: '/tmp/codex/session_index.jsonl', socketPath: '/tmp/cli2im/codex-notify.sock',
      store, resolveAdapter: () => adapter, timeZone: 'UTC',
      dependencies: {
        metadataResolver: { resolve: vi.fn().mockResolvedValue({
          projectName: 'cli2im', taskName: '真实适配器停机', surface: 'CLI', shortTaskId: 'session_',
        }) },
        createMonitor: (handler) => {
          onRollout = handler;
          return { start: vi.fn(), stop: vi.fn(async () => { await activeCallback; }) };
        },
        createSocket: () => ({ start: vi.fn(), stop: vi.fn() }),
      },
    });
    const filePath = '/tmp/codex/sessions/rollout-production-adapter-shutdown.jsonl';
    await onRollout?.({
      type: 'session_meta', sessionId: 'session_production_adapter', cwd: '/tmp/project', source: 'cli',
    }, filePath);
    await onRollout?.({
      type: 'turn_context', turnId: 'turn_production_adapter', cwd: '/tmp/project',
    }, filePath);
    activeCallback = Promise.resolve(onRollout?.({
      type: 'question', turnId: 'turn_production_adapter', requestId: 'question_production_adapter',
      occurredAt: 1,
    }, filePath)).then(() => undefined);
    await vi.waitFor(() => expect(sdkCreate).toHaveBeenCalledTimes(1));

    const stopping = service.stop();
    const outcome = await Promise.race([
      stopping.then(() => 'stopped' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 100)),
    ]);
    if (outcome === 'timeout') {
      sdkResult.resolve({ code: 0, data: { message_id: 'om_cleanup' } });
      await stopping;
    }

    expect(outcome).toBe('stopped');
    expect(await store.listPendingNotifications()).toHaveLength(1);
    store.close();
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

function startupCatchupRollout(input: {
  sessionId: string;
  currentTurnIds: string[];
  currentTask: string;
  oldTimestamp: number;
  currentTimestamp: number;
  requestId: string;
}): string {
  const oldTurnId = `${input.sessionId}_old_turn`;
  const lines: object[] = [
    {
      type: 'session_meta',
      payload: { id: input.sessionId, cwd: '/tmp/startup-project', source: 'cli' },
    },
    {
      type: 'turn_context',
      payload: { turn_id: oldTurnId, cwd: '/tmp/startup-project' },
    },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'old task' }],
        internal_chat_message_metadata_passthrough: { turn_id: oldTurnId },
      },
    },
    {
      timestamp: new Date(input.oldTimestamp).toISOString(),
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'request_user_input',
        call_id: `${input.sessionId}_old_question`,
        arguments: '{"questions":[{"question":"old private question"}]}',
        internal_chat_message_metadata_passthrough: { turn_id: oldTurnId },
      },
    },
    {
      timestamp: new Date(input.oldTimestamp).toISOString(),
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: oldTurnId },
    },
  ];
  for (const turnId of input.currentTurnIds) {
    lines.push(
      {
        type: 'turn_context',
        payload: { turn_id: turnId, cwd: '/tmp/startup-project' },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: input.currentTask }],
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        },
      },
    );
  }
  lines.push({
    timestamp: new Date(input.currentTimestamp).toISOString(),
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'request_user_input',
      call_id: input.requestId,
      arguments: '{"questions":[{"question":"current private question"}]}',
    },
  });
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
}

function startupTerminalCatchupRollout(input: {
  sessionId: string;
  currentTurnId: string;
  currentTask: string;
  historicalEventType: 'task_complete' | 'turn_aborted';
  oldTimestamp: number;
  currentTimestamp: number;
  requestId: string;
}): string {
  const historicalTurnId = `${input.sessionId}_historical_turn`;
  return `${[
    {
      type: 'session_meta',
      payload: {
        id: input.sessionId,
        cwd: '/tmp/startup-project',
        source: 'cli',
        safe_filler: 'x'.repeat(40_000),
      },
    },
    {
      type: 'turn_context',
      payload: { turn_id: historicalTurnId, cwd: '/tmp/startup-project' },
    },
    {
      timestamp: new Date(input.oldTimestamp).toISOString(),
      type: 'event_msg',
      payload: { type: input.historicalEventType, turn_id: historicalTurnId },
    },
    {
      type: 'turn_context',
      payload: { turn_id: input.currentTurnId, cwd: '/tmp/startup-project' },
    },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: input.currentTask }],
        internal_chat_message_metadata_passthrough: { turn_id: input.currentTurnId },
      },
    },
    {
      timestamp: new Date(input.currentTimestamp).toISOString(),
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'request_user_input',
        call_id: input.requestId,
        arguments: '{"questions":[{"question":"current private question"}]}',
      },
    },
    {
      timestamp: new Date(input.currentTimestamp + 1_000).toISOString(),
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: input.currentTurnId,
        duration_ms: 5_000,
      },
    },
  ].map((line) => JSON.stringify(line)).join('\n')}\n`;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
