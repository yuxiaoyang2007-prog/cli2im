import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationRouter, type NotificationLogEntry } from '../src/notifications/router.js';
import type { CodexNotificationEvent } from '../src/notifications/types.js';
import { SessionStore } from '../src/session/store.js';
import type { PlatformAdapter } from '../src/types.js';

const STARTED_AT = new Date('2026-07-15T14:32:00-04:00').getTime();

function attentionEvent(
  overrides: Partial<CodexNotificationEvent> = {},
): CodexNotificationEvent {
  return {
    eventKey: 'evt_attention_0123456789abcdef',
    kind: 'needs_attention',
    reason: 'approval',
    sessionId: 'abcdefgh-1234',
    turnId: 'turn_1',
    requestId: 'request_1',
    projectName: 'cli2im',
    taskName: '为所有 Codex 任务增加飞书提醒',
    surface: 'ChatGPT Work',
    occurredAt: STARTED_AT,
    shortTaskId: 'abcdefgh',
    ...overrides,
  };
}

function timerDependencies() {
  return {
    now: () => Date.now(),
    setTimeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
  };
}

function adapterWith(send: PlatformAdapter['send'], name = 'feishu'): PlatformAdapter {
  return {
    name,
    connect: vi.fn(),
    disconnect: vi.fn(),
    onMessage: vi.fn(),
    send,
    editMessage: vi.fn(),
    deleteMessage: vi.fn(),
  };
}

async function bindTarget(store: SessionStore): Promise<void> {
  await store.bindNotificationTarget({
    botName: 'codexbot',
    platform: 'feishu',
    chatId: 'oc_notification_target',
    userId: 'ou_notification_user',
    updatedAt: STARTED_AT,
  });
}

describe('NotificationRouter', () => {
  const stores: SessionStore[] = [];
  const temporaryDirectories: string[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(STARTED_AT);
  });

  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
    vi.useRealTimers();
  });

  it('discards a newly enqueued event when no binding exists', async () => {
    const store = await SessionStore.create(':memory:');
    stores.push(store);
    const send = vi.fn<PlatformAdapter['send']>();
    const router = new NotificationRouter({
      store,
      botName: 'codexbot',
      adapters: new Map([['codexbot', adapterWith(send)]]),
      timeZone: 'America/New_York',
      log: vi.fn(),
      ...timerDependencies(),
    });

    await expect(router.handle(attentionEvent())).resolves.toBe('discarded');
    expect(send).not.toHaveBeenCalled();
    expect(await store.listPendingNotifications()).toEqual([]);
  });

  it('deduplicates an event key and sends it exactly once', async () => {
    const store = await SessionStore.create(':memory:');
    stores.push(store);
    await bindTarget(store);
    const send = vi.fn<PlatformAdapter['send']>().mockResolvedValue('om_1');
    const router = new NotificationRouter({
      store,
      botName: 'codexbot',
      adapters: new Map([['codexbot', adapterWith(send)]]),
      timeZone: 'America/New_York',
      ...timerDependencies(),
    });
    const event = attentionEvent();

    await expect(router.handle(event)).resolves.toBe('delivered');
    await expect(router.handle(event)).resolves.toBe('duplicate');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('delivers immediately through only the configured Feishu bot binding', async () => {
    const store = await SessionStore.create(':memory:');
    stores.push(store);
    await bindTarget(store);
    const configuredSend = vi.fn<PlatformAdapter['send']>().mockResolvedValue('om_1');
    const unrelatedSend = vi.fn<PlatformAdapter['send']>().mockResolvedValue('om_other');
    const router = new NotificationRouter({
      store,
      botName: 'codexbot',
      adapters: new Map([
        ['codexbot', adapterWith(configuredSend)],
        ['other-feishu-bot', adapterWith(unrelatedSend)],
      ]),
      timeZone: 'America/New_York',
      ...timerDependencies(),
    });

    await expect(router.handle(attentionEvent())).resolves.toBe('delivered');
    expect(configuredSend).toHaveBeenCalledWith('oc_notification_target', {
      card: expect.objectContaining({
        type: 'final',
        title: '🟠 待你处理',
        headerTemplate: 'orange',
      }),
    });
    expect(unrelatedSend).not.toHaveBeenCalled();
    expect(await store.listPendingNotifications()).toEqual([]);
  });

  it('persists and schedules retry delays of 1, 5, and 20 seconds before succeeding', async () => {
    const store = await SessionStore.create(':memory:');
    stores.push(store);
    await bindTarget(store);
    const sendTimes: number[] = [];
    const send = vi.fn<PlatformAdapter['send']>().mockImplementation(async () => {
      sendTimes.push(Date.now());
      if (sendTimes.length < 4) throw new TypeError('sensitive remote response');
      return 'om_success';
    });
    const markAttempt = vi.spyOn(store, 'markNotificationAttempt');
    const logs: NotificationLogEntry[] = [];
    const router = new NotificationRouter({
      store,
      botName: 'codexbot',
      adapters: new Map([['codexbot', adapterWith(send)]]),
      timeZone: 'America/New_York',
      log: (entry) => logs.push(entry),
      ...timerDependencies(),
    });

    const event = Object.assign(attentionEvent(), {
      prompt: 'RAW_PROMPT',
      command: 'RAW_COMMAND',
      output: 'RAW_SECRET_OUTPUT',
    });
    await expect(router.handle(event)).resolves.toBe('pending');
    expect(markAttempt).toHaveBeenLastCalledWith(
      'evt_attention_0123456789abcdef',
      STARTED_AT + 1_000,
    );
    expect(JSON.stringify(await store.listPendingNotifications())).not.toMatch(/RAW_|SECRET/);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(markAttempt).toHaveBeenLastCalledWith(
      'evt_attention_0123456789abcdef',
      STARTED_AT + 6_000,
    );

    await vi.advanceTimersByTimeAsync(5_000);
    expect(markAttempt).toHaveBeenLastCalledWith(
      'evt_attention_0123456789abcdef',
      STARTED_AT + 26_000,
    );

    await vi.advanceTimersByTimeAsync(20_000);
    expect(sendTimes).toEqual([
      STARTED_AT,
      STARTED_AT + 1_000,
      STARTED_AT + 6_000,
      STARTED_AT + 26_000,
    ]);
    expect(await store.listPendingNotifications()).toEqual([]);
    expect(logs).toEqual([
      expect.objectContaining({ attempt: 1, errorClass: 'TypeError' }),
      expect.objectContaining({ attempt: 2, errorClass: 'TypeError' }),
      expect.objectContaining({ attempt: 3, errorClass: 'TypeError' }),
    ]);
    expect(JSON.stringify(logs)).not.toContain('sensitive remote response');
  });

  it('marks the delivery failed after four total attempts and schedules no fifth send', async () => {
    const store = await SessionStore.create(':memory:');
    stores.push(store);
    await bindTarget(store);
    const send = vi.fn<PlatformAdapter['send']>().mockRejectedValue(new Error('secret output'));
    const markAttempt = vi.spyOn(store, 'markNotificationAttempt');
    const markFailed = vi.spyOn(store, 'markNotificationFailed');
    const router = new NotificationRouter({
      store,
      botName: 'codexbot',
      adapters: new Map([['codexbot', adapterWith(send)]]),
      timeZone: 'America/New_York',
      log: vi.fn(),
      ...timerDependencies(),
    });

    await expect(router.handle(attentionEvent())).resolves.toBe('pending');
    await vi.advanceTimersByTimeAsync(1_000 + 5_000 + 20_000);

    expect(send).toHaveBeenCalledTimes(4);
    expect(markAttempt).toHaveBeenLastCalledWith(
      'evt_attention_0123456789abcdef',
      null,
    );
    expect(markFailed).toHaveBeenCalledWith('evt_attention_0123456789abcdef');
    expect(await store.listPendingNotifications()).toEqual([]);

    await vi.runAllTimersAsync();
    expect(send).toHaveBeenCalledTimes(4);
  });

  it('resumes a persisted retry at its due time after a simulated restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cli2im-router-restart-'));
    temporaryDirectories.push(directory);
    const dbPath = join(directory, 'sessions.db');
    const firstStore = await SessionStore.create(dbPath);
    await bindTarget(firstStore);
    const firstSend = vi.fn<PlatformAdapter['send']>().mockRejectedValue(new Error('offline'));
    const firstRouter = new NotificationRouter({
      store: firstStore,
      botName: 'codexbot',
      adapters: new Map([['codexbot', adapterWith(firstSend)]]),
      timeZone: 'America/New_York',
      log: vi.fn(),
      ...timerDependencies(),
    });

    await expect(firstRouter.handle(attentionEvent())).resolves.toBe('pending');
    firstRouter.stop();
    firstStore.close();

    vi.setSystemTime(STARTED_AT + 250);
    const reloadedStore = await SessionStore.create(dbPath);
    stores.push(reloadedStore);
    const resumedSend = vi.fn<PlatformAdapter['send']>().mockResolvedValue('om_resumed');
    const resumedRouter = new NotificationRouter({
      store: reloadedStore,
      botName: 'codexbot',
      adapters: new Map([['codexbot', adapterWith(resumedSend)]]),
      timeZone: 'America/New_York',
      ...timerDependencies(),
    });

    await resumedRouter.resumePending();
    await vi.advanceTimersByTimeAsync(749);
    expect(resumedSend).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(resumedSend).toHaveBeenCalledTimes(1);
    expect(await reloadedStore.listPendingNotifications()).toEqual([]);
  });

  it('fails closed when the configured adapter is missing or not Feishu', async () => {
    const store = await SessionStore.create(':memory:');
    stores.push(store);
    await bindTarget(store);
    const telegramSend = vi.fn<PlatformAdapter['send']>().mockResolvedValue('unexpected');
    const otherFeishuSend = vi.fn<PlatformAdapter['send']>().mockResolvedValue('unexpected');
    const markFailed = vi.spyOn(store, 'markNotificationFailed');
    const logs: NotificationLogEntry[] = [];
    const adapters = new Map([
      ['codexbot', adapterWith(telegramSend, 'telegram')],
      ['other-feishu-bot', adapterWith(otherFeishuSend)],
    ]);
    const router = new NotificationRouter({
      store,
      botName: 'codexbot',
      adapters,
      timeZone: 'America/New_York',
      log: (entry) => logs.push(entry),
      ...timerDependencies(),
    });

    await expect(router.handle(attentionEvent())).resolves.toBe('pending');
    adapters.delete('codexbot');
    await expect(router.handle(attentionEvent({ eventKey: 'evt_missing_0123456789abcdef' })))
      .resolves.toBe('pending');
    expect(markFailed).toHaveBeenNthCalledWith(1, 'evt_attention_0123456789abcdef');
    expect(markFailed).toHaveBeenNthCalledWith(2, 'evt_missing_0123456789abcdef');
    expect(telegramSend).not.toHaveBeenCalled();
    expect(otherFeishuSend).not.toHaveBeenCalled();
    expect(logs).toEqual([
      {
        kind: 'needs_attention',
        eventKey: 'evt_atte',
        attempt: 1,
        errorClass: 'adapter_unavailable',
      },
      {
        kind: 'needs_attention',
        eventKey: 'evt_miss',
        attempt: 1,
        errorClass: 'adapter_unavailable',
      },
    ]);
  });
});
