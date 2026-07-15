import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import initSqlJs from 'sql.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildNotificationCard } from '../src/notifications/card.js';
import { NotificationRouter, type NotificationLogEntry } from '../src/notifications/router.js';
import type { CodexNotificationEvent } from '../src/notifications/types.js';
import { SessionStore } from '../src/session/store.js';
import type { PlatformAdapter } from '../src/types.js';

const STARTED_AT = new Date('2026-07-15T14:32:00-04:00').getTime();
const require = createRequire(import.meta.url);
const sqlWasmDir = dirname(require.resolve('sql.js/dist/sql-wasm.wasm'));

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

function adapterWith(
  send: PlatformAdapter['send'],
  name = 'feishu',
  replaceCard: NonNullable<PlatformAdapter['replaceCard']> = vi.fn(),
): PlatformAdapter {
  return {
    name,
    connect: vi.fn(),
    disconnect: vi.fn(),
    onMessage: vi.fn(),
    send,
    replaceCard,
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
    }, { idempotencyKey: 'evt_attention_0123456789abcdef' });
    expect(unrelatedSend).not.toHaveBeenCalled();
    expect(await store.listPendingNotifications()).toEqual([]);
  });

  it('creates the base card then patches the same message when acknowledgement is delayed', async () => {
    const store = await SessionStore.create(':memory:');
    stores.push(store);
    await bindTarget(store);
    const event = attentionEvent();
    const send = vi.fn<PlatformAdapter['send']>().mockImplementation(async () => {
      vi.setSystemTime(STARTED_AT + 31_000);
      return 'om_delayed_ack';
    });
    const replaceCard = vi.fn<NonNullable<PlatformAdapter['replaceCard']>>()
      .mockResolvedValue(undefined);
    const router = new NotificationRouter({
      store,
      botName: 'codexbot',
      adapters: new Map([['codexbot', adapterWith(send, 'feishu', replaceCard)]]),
      timeZone: 'America/New_York',
      ...timerDependencies(),
    });

    await expect(router.handle(event)).resolves.toBe('delivered');

    expect(send).toHaveBeenCalledWith('oc_notification_target', {
      card: buildNotificationCard(event, {
        delayed: false,
        timeZone: 'America/New_York',
      }),
    }, { idempotencyKey: event.eventKey });
    expect(replaceCard).toHaveBeenCalledOnce();
    expect(replaceCard).toHaveBeenCalledWith(
      'om_delayed_ack',
      buildNotificationCard(event, {
        delayed: true,
        timeZone: 'America/New_York',
      }),
    );
    const patchedCard = replaceCard.mock.calls[0]?.[1];
    expect(patchedCard?.content.split('\n').at(-1)).toBe('⚠️ 延迟送达');
  });

  it('does not patch a message acknowledged within 30 seconds', async () => {
    const store = await SessionStore.create(':memory:');
    stores.push(store);
    await bindTarget(store);
    const send = vi.fn<PlatformAdapter['send']>().mockImplementation(async () => {
      vi.setSystemTime(STARTED_AT + 29_500);
      return 'om_on_time';
    });
    const replaceCard = vi.fn<NonNullable<PlatformAdapter['replaceCard']>>();
    const router = new NotificationRouter({
      store,
      botName: 'codexbot',
      adapters: new Map([['codexbot', adapterWith(send, 'feishu', replaceCard)]]),
      timeZone: 'America/New_York',
      ...timerDependencies(),
    });

    await expect(router.handle(attentionEvent())).resolves.toBe('delivered');

    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(send.mock.calls[0]?.[1])).not.toContain('⚠️ 延迟送达');
    expect(replaceCard).not.toHaveBeenCalled();
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
    const markAttemptStarted = vi.spyOn(store, 'markNotificationAttemptStarted');
    const setNextRetry = vi.spyOn(store, 'setNotificationNextRetry');
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
    expect(markAttemptStarted).toHaveBeenLastCalledWith(
      'evt_attention_0123456789abcdef',
      STARTED_AT,
    );
    expect(setNextRetry).toHaveBeenLastCalledWith(
      'evt_attention_0123456789abcdef',
      STARTED_AT + 1_000,
    );
    expect(JSON.stringify(await store.listPendingNotifications())).not.toMatch(/RAW_|SECRET/);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(markAttemptStarted).toHaveBeenLastCalledWith(
      'evt_attention_0123456789abcdef',
      STARTED_AT + 1_000,
    );
    expect(setNextRetry).toHaveBeenLastCalledWith(
      'evt_attention_0123456789abcdef',
      STARTED_AT + 6_000,
    );

    await vi.advanceTimersByTimeAsync(5_000);
    expect(markAttemptStarted).toHaveBeenLastCalledWith(
      'evt_attention_0123456789abcdef',
      STARTED_AT + 6_000,
    );
    expect(setNextRetry).toHaveBeenLastCalledWith(
      'evt_attention_0123456789abcdef',
      STARTED_AT + 26_000,
    );

    await vi.advanceTimersByTimeAsync(20_000);
    expect(markAttemptStarted).toHaveBeenLastCalledWith(
      'evt_attention_0123456789abcdef',
      STARTED_AT + 26_000,
    );
    expect(markAttemptStarted).toHaveBeenCalledTimes(4);
    expect(setNextRetry).toHaveBeenCalledTimes(3);
    expect(sendTimes).toEqual([
      STARTED_AT,
      STARTED_AT + 1_000,
      STARTED_AT + 6_000,
      STARTED_AT + 26_000,
    ]);
    expect(send.mock.calls.map(([, , options]) => options?.idempotencyKey)).toEqual([
      event.eventKey,
      event.eventKey,
      event.eventKey,
      event.eventKey,
    ]);
    expect(send.mock.calls.map(([, content]) => content)).toEqual([
      send.mock.calls[0]?.[1],
      send.mock.calls[0]?.[1],
      send.mock.calls[0]?.[1],
      send.mock.calls[0]?.[1],
    ]);
    expect(JSON.stringify(send.mock.calls[0]?.[1])).not.toContain('⚠️ 延迟送达');
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
    const markAttemptStarted = vi.spyOn(store, 'markNotificationAttemptStarted');
    const setNextRetry = vi.spyOn(store, 'setNotificationNextRetry');
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
    expect(markAttemptStarted).toHaveBeenCalledTimes(4);
    expect(setNextRetry).toHaveBeenCalledTimes(3);
    expect(markFailed).toHaveBeenCalledWith('evt_attention_0123456789abcdef');
    expect(await store.listPendingNotifications()).toEqual([]);

    await vi.runAllTimersAsync();
    expect(send).toHaveBeenCalledTimes(4);
  });

  it('retries only local finalization after a delivered-state failure', async () => {
    const store = await SessionStore.create(':memory:');
    stores.push(store);
    await bindTarget(store);
    const event = attentionEvent({ eventKey: '0123456789abcdef01234567' });
    const transportDeliveries = new Set<string>();
    const send = vi.fn<PlatformAdapter['send']>().mockImplementation(async (
      _chatId,
      _content,
      options,
    ) => {
      transportDeliveries.add(options?.idempotencyKey ?? `missing-${transportDeliveries.size}`);
      return 'om_transport_delivery';
    });
    const originalMarkDelivered = store.markNotificationDelivered.bind(store);
    const markDelivered = vi.spyOn(store, 'markNotificationDelivered')
      .mockRejectedValueOnce(new Error('local state write failed'))
      .mockImplementation(originalMarkDelivered);
    const logs: NotificationLogEntry[] = [];
    const router = new NotificationRouter({
      store,
      botName: 'codexbot',
      adapters: new Map([['codexbot', adapterWith(send)]]),
      timeZone: 'America/New_York',
      log: (entry) => logs.push(entry),
      ...timerDependencies(),
    });

    await expect(router.handle(event)).resolves.toBe('pending');
    await vi.advanceTimersByTimeAsync(1_000);

    expect(send).toHaveBeenCalledTimes(1);
    expect(markDelivered).toHaveBeenCalledTimes(2);
    expect(transportDeliveries).toEqual(new Set([event.eventKey]));
    expect(send.mock.calls.map(([, , options]) => options?.idempotencyKey)).toEqual([
      event.eventKey,
    ]);
    expect(logs).toEqual([
      {
        kind: 'needs_attention',
        eventKey: '01234567',
        attempt: 1,
        errorClass: 'delivery_state_error',
      },
    ]);
    expect(await store.listPendingNotifications()).toEqual([]);
  });

  it('retries receipt persistence locally without creating a second message', async () => {
    const store = await SessionStore.create(':memory:');
    stores.push(store);
    await bindTarget(store);
    const send = vi.fn<PlatformAdapter['send']>().mockResolvedValue('om_receipt_retry');
    const originalRecordReceipt = store.recordNotificationReceipt.bind(store);
    const recordReceipt = vi.spyOn(store, 'recordNotificationReceipt')
      .mockRejectedValueOnce(new Error('local receipt write failed'))
      .mockImplementation(originalRecordReceipt);
    const router = new NotificationRouter({
      store,
      botName: 'codexbot',
      adapters: new Map([['codexbot', adapterWith(send)]]),
      timeZone: 'America/New_York',
      log: vi.fn(),
      ...timerDependencies(),
    });

    await expect(router.handle(attentionEvent())).resolves.toBe('pending');
    await vi.advanceTimersByTimeAsync(1_000);

    expect(send).toHaveBeenCalledTimes(1);
    expect(recordReceipt).toHaveBeenCalledTimes(2);
    expect(await store.listPendingNotifications()).toEqual([]);
  });

  it('retries a delayed-card patch without creating another message', async () => {
    const store = await SessionStore.create(':memory:');
    stores.push(store);
    await bindTarget(store);
    const send = vi.fn<PlatformAdapter['send']>().mockImplementation(async () => {
      vi.setSystemTime(STARTED_AT + 31_000);
      return 'om_patch_retry';
    });
    const replaceCard = vi.fn<NonNullable<PlatformAdapter['replaceCard']>>()
      .mockRejectedValueOnce(new Error('patch unavailable'))
      .mockResolvedValue(undefined);
    const router = new NotificationRouter({
      store,
      botName: 'codexbot',
      adapters: new Map([['codexbot', adapterWith(send, 'feishu', replaceCard)]]),
      timeZone: 'America/New_York',
      log: vi.fn(),
      ...timerDependencies(),
    });

    await expect(router.handle(attentionEvent())).resolves.toBe('pending');
    await vi.advanceTimersByTimeAsync(1_000);

    expect(send).toHaveBeenCalledTimes(1);
    expect(replaceCard).toHaveBeenCalledTimes(2);
    expect(replaceCard.mock.calls.map(([messageId]) => messageId)).toEqual([
      'om_patch_retry',
      'om_patch_retry',
    ]);
    expect(await store.listPendingNotifications()).toEqual([]);
  });

  it('never re-enters the adapter in-process after external acceptance', async () => {
    const store = await SessionStore.create(':memory:');
    stores.push(store);
    await bindTarget(store);
    const send = vi.fn<PlatformAdapter['send']>().mockResolvedValue('om_accepted');
    vi.spyOn(store, 'markNotificationDelivered')
      .mockRejectedValue(new Error('local state remains unavailable'));
    const router = new NotificationRouter({
      store,
      botName: 'codexbot',
      adapters: new Map([['codexbot', adapterWith(send)]]),
      timeZone: 'America/New_York',
      log: vi.fn(),
      ...timerDependencies(),
    });

    await expect(router.handle(attentionEvent())).resolves.toBe('pending');
    await vi.runAllTimersAsync();
    expect(send).toHaveBeenCalledTimes(1);

    await router.resumePending();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not overlap resumePending with an in-flight immediate delivery', async () => {
    const store = await SessionStore.create(':memory:');
    stores.push(store);
    await bindTarget(store);
    const gate = deferred<string>();
    const send = vi.fn<PlatformAdapter['send']>().mockImplementation(() => gate.promise);
    const markAttemptStarted = vi.spyOn(store, 'markNotificationAttemptStarted');
    const router = new NotificationRouter({
      store,
      botName: 'codexbot',
      adapters: new Map([['codexbot', adapterWith(send)]]),
      timeZone: 'America/New_York',
      ...timerDependencies(),
    });

    const handling = router.handle(attentionEvent());
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(markAttemptStarted).toHaveBeenCalledWith(
      'evt_attention_0123456789abcdef',
      STARTED_AT,
    );
    expect(markAttemptStarted.mock.invocationCallOrder[0])
      .toBeLessThan(send.mock.invocationCallOrder[0]);
    expect(await store.listPendingNotifications()).toEqual([
      {
        event: attentionEvent(),
        status: 'pending',
        attempts: 1,
        firstAttemptAt: STARTED_AT,
        lastAttemptAt: STARTED_AT,
        nextRetryAt: null,
        deliveredAt: null,
        transportMessageId: null,
        acknowledgedAt: null,
        delayedPatchCompletedAt: null,
      },
    ]);

    await router.resumePending();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);

    gate.resolve('om_1');
    await expect(handling).resolves.toBe('delivered');
    expect(await store.listPendingNotifications()).toEqual([]);
  });

  it('restarts within 55 minutes with the same uuid and base card, then patches for delayed ack', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cli2im-router-restart-'));
    temporaryDirectories.push(directory);
    const dbPath = join(directory, 'sessions.db');
    const firstStore = await SessionStore.create(dbPath);
    await bindTarget(firstStore);
    const event = attentionEvent({ occurredAt: STARTED_AT - 29_500 });
    const firstSend = vi.fn<PlatformAdapter['send']>().mockRejectedValue(new Error('offline'));
    const firstRouter = new NotificationRouter({
      store: firstStore,
      botName: 'codexbot',
      adapters: new Map([['codexbot', adapterWith(firstSend)]]),
      timeZone: 'America/New_York',
      log: vi.fn(),
      ...timerDependencies(),
    });

    await expect(firstRouter.handle(event)).resolves.toBe('pending');
    firstRouter.stop();
    firstStore.close();

    vi.setSystemTime(STARTED_AT + 2_000);
    const reloadedStore = await SessionStore.create(dbPath);
    stores.push(reloadedStore);
    const resumedSend = vi.fn<PlatformAdapter['send']>().mockResolvedValue('om_resumed');
    const replaceCard = vi.fn<NonNullable<PlatformAdapter['replaceCard']>>()
      .mockResolvedValue(undefined);
    const resumedRouter = new NotificationRouter({
      store: reloadedStore,
      botName: 'codexbot',
      adapters: new Map([['codexbot', adapterWith(resumedSend, 'feishu', replaceCard)]]),
      timeZone: 'America/New_York',
      ...timerDependencies(),
    });

    await resumedRouter.resumePending();
    await vi.advanceTimersByTimeAsync(0);
    expect(resumedSend).toHaveBeenCalledTimes(1);
    expect(firstSend.mock.calls[0]?.[2]?.idempotencyKey).toBe(event.eventKey);
    expect(resumedSend.mock.calls[0]?.[2]?.idempotencyKey).toBe(event.eventKey);
    expect(resumedSend.mock.calls[0]?.[1]).toEqual(firstSend.mock.calls[0]?.[1]);
    expect(JSON.stringify(resumedSend.mock.calls[0]?.[1])).not.toContain('⚠️ 延迟送达');
    expect(replaceCard).toHaveBeenCalledWith(
      'om_resumed',
      buildNotificationCard(event, {
        delayed: true,
        timeZone: 'America/New_York',
      }),
    );
    expect(await reloadedStore.listPendingNotifications()).toEqual([]);
  });

  it('resumes a persisted receipt with delayed patch and finalization but no create', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cli2im-router-receipt-'));
    temporaryDirectories.push(directory);
    const dbPath = join(directory, 'sessions.db');
    const firstStore = await SessionStore.create(dbPath);
    await bindTarget(firstStore);
    const event = attentionEvent({ eventKey: '555555555555555555555555' });
    await firstStore.enqueueNotification(event);
    await firstStore.markNotificationAttemptStarted(event.eventKey, STARTED_AT);
    await firstStore.recordNotificationReceipt(
      event.eventKey,
      'om_persisted_receipt',
      STARTED_AT + 31_000,
    );
    firstStore.close();

    vi.setSystemTime(STARTED_AT + 32_000);
    const reloadedStore = await SessionStore.create(dbPath);
    stores.push(reloadedStore);
    const send = vi.fn<PlatformAdapter['send']>().mockResolvedValue('must_not_create');
    const replaceCard = vi.fn<NonNullable<PlatformAdapter['replaceCard']>>()
      .mockResolvedValue(undefined);
    const markDelivered = vi.spyOn(reloadedStore, 'markNotificationDelivered');
    const router = new NotificationRouter({
      store: reloadedStore,
      botName: 'codexbot',
      adapters: new Map([['codexbot', adapterWith(send, 'feishu', replaceCard)]]),
      timeZone: 'America/New_York',
      ...timerDependencies(),
    });

    await router.resumePending();
    await vi.advanceTimersByTimeAsync(0);

    expect(send).not.toHaveBeenCalled();
    expect(replaceCard).toHaveBeenCalledWith(
      'om_persisted_receipt',
      buildNotificationCard(event, {
        delayed: true,
        timeZone: 'America/New_York',
      }),
    );
    expect(markDelivered).toHaveBeenCalledTimes(1);
    expect(await reloadedStore.listPendingNotifications()).toEqual([]);
  });

  it('expires from immutable first uuid use across repeated near-boundary restarts', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cli2im-router-first-attempt-expiry-'));
    temporaryDirectories.push(directory);
    const dbPath = join(directory, 'sessions.db');
    const event = attentionEvent({ eventKey: '666666666666666666666666' });

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
    await expect(firstRouter.handle(event)).resolves.toBe('pending');
    firstRouter.stop();
    firstStore.close();

    vi.setSystemTime(STARTED_AT + 54 * 60_000);
    const secondStore = await SessionStore.create(dbPath);
    const secondSend = vi.fn<PlatformAdapter['send']>().mockRejectedValue(new Error('offline'));
    const secondRouter = new NotificationRouter({
      store: secondStore,
      botName: 'codexbot',
      adapters: new Map([['codexbot', adapterWith(secondSend)]]),
      timeZone: 'America/New_York',
      log: vi.fn(),
      ...timerDependencies(),
    });
    await secondRouter.resumePending();
    await vi.advanceTimersByTimeAsync(0);
    expect(secondSend).toHaveBeenCalledTimes(1);
    secondRouter.stop();
    secondStore.close();

    vi.setSystemTime(STARTED_AT + 108 * 60_000);
    const finalStore = await SessionStore.create(dbPath);
    stores.push(finalStore);
    const finalSend = vi.fn<PlatformAdapter['send']>().mockResolvedValue('must_not_create');
    const markFailed = vi.spyOn(finalStore, 'markNotificationFailed');
    const finalRouter = new NotificationRouter({
      store: finalStore,
      botName: 'codexbot',
      adapters: new Map([['codexbot', adapterWith(finalSend)]]),
      timeZone: 'America/New_York',
      log: vi.fn(),
      ...timerDependencies(),
    });

    await finalRouter.resumePending();
    await vi.runAllTimersAsync();

    expect(firstSend).toHaveBeenCalledTimes(1);
    expect(finalSend).not.toHaveBeenCalled();
    expect(markFailed).toHaveBeenCalledWith(event.eventKey);
    expect(await finalStore.listPendingNotifications()).toEqual([]);
  });

  it('expires a persisted attempted delivery after the 55-minute uuid safety window', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cli2im-router-expiry-'));
    temporaryDirectories.push(directory);
    const dbPath = join(directory, 'sessions.db');
    const firstStore = await SessionStore.create(dbPath);
    await bindTarget(firstStore);
    const event = attentionEvent({ eventKey: '111111111111111111111111' });
    const firstRouter = new NotificationRouter({
      store: firstStore,
      botName: 'codexbot',
      adapters: new Map([[
        'codexbot',
        adapterWith(vi.fn<PlatformAdapter['send']>().mockRejectedValue(new Error('offline'))),
      ]]),
      timeZone: 'America/New_York',
      log: vi.fn(),
      ...timerDependencies(),
    });
    await expect(firstRouter.handle(event)).resolves.toBe('pending');
    firstRouter.stop();
    firstStore.close();

    vi.setSystemTime(STARTED_AT + 55 * 60_000);
    const reloadedStore = await SessionStore.create(dbPath);
    stores.push(reloadedStore);
    const send = vi.fn<PlatformAdapter['send']>().mockResolvedValue('must_not_send');
    const markFailed = vi.spyOn(reloadedStore, 'markNotificationFailed');
    const router = new NotificationRouter({
      store: reloadedStore,
      botName: 'codexbot',
      adapters: new Map([['codexbot', adapterWith(send)]]),
      timeZone: 'America/New_York',
      log: vi.fn(),
      ...timerDependencies(),
    });

    await router.resumePending();
    await vi.runAllTimersAsync();

    expect(send).not.toHaveBeenCalled();
    expect(markFailed).toHaveBeenCalledWith(event.eventKey);
    expect(await reloadedStore.listPendingNotifications()).toEqual([]);
  });

  it('expires an in-process external retry whose timer fires after the safety window', async () => {
    const store = await SessionStore.create(':memory:');
    stores.push(store);
    await bindTarget(store);
    const event = attentionEvent({ eventKey: '444444444444444444444444' });
    const send = vi.fn<PlatformAdapter['send']>().mockRejectedValue(new Error('offline'));
    const markFailed = vi.spyOn(store, 'markNotificationFailed');
    const router = new NotificationRouter({
      store,
      botName: 'codexbot',
      adapters: new Map([['codexbot', adapterWith(send)]]),
      timeZone: 'America/New_York',
      log: vi.fn(),
      ...timerDependencies(),
    });

    await expect(router.handle(event)).resolves.toBe('pending');
    vi.setSystemTime(STARTED_AT + 55 * 60_000);
    await vi.runOnlyPendingTimersAsync();

    expect(send).toHaveBeenCalledTimes(1);
    expect(markFailed).toHaveBeenCalledWith(event.eventKey);
    expect(await store.listPendingNotifications()).toEqual([]);
  });

  it('fails a migrated attempted row whose first uuid use is unverifiable', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cli2im-router-legacy-expiry-'));
    temporaryDirectories.push(directory);
    const dbPath = join(directory, 'sessions.db');
    const event = attentionEvent({ eventKey: '222222222222222222222222' });
    await createLegacyNotificationDatabase(dbPath, event, 1);
    const store = await SessionStore.create(dbPath);
    stores.push(store);
    await bindTarget(store);
    const send = vi.fn<PlatformAdapter['send']>().mockResolvedValue('must_not_send');
    const markFailed = vi.spyOn(store, 'markNotificationFailed');
    const router = new NotificationRouter({
      store,
      botName: 'codexbot',
      adapters: new Map([['codexbot', adapterWith(send)]]),
      timeZone: 'America/New_York',
      log: vi.fn(),
      ...timerDependencies(),
    });

    await router.resumePending();
    await vi.runAllTimersAsync();

    expect(send).not.toHaveBeenCalled();
    expect(markFailed).toHaveBeenCalledWith(event.eventKey);
    expect(await store.listPendingNotifications()).toEqual([]);
  });

  it('safely creates the base card for an old attempts-zero row then patches it as delayed', async () => {
    const store = await SessionStore.create(':memory:');
    stores.push(store);
    await bindTarget(store);
    const event = attentionEvent({
      eventKey: '333333333333333333333333',
      occurredAt: STARTED_AT - 60 * 60_000,
    });
    await store.enqueueNotification(event);
    const send = vi.fn<PlatformAdapter['send']>().mockResolvedValue('om_old_first_attempt');
    const replaceCard = vi.fn<NonNullable<PlatformAdapter['replaceCard']>>()
      .mockResolvedValue(undefined);
    const router = new NotificationRouter({
      store,
      botName: 'codexbot',
      adapters: new Map([['codexbot', adapterWith(send, 'feishu', replaceCard)]]),
      timeZone: 'America/New_York',
      ...timerDependencies(),
    });

    await router.resumePending();
    await vi.advanceTimersByTimeAsync(0);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[2]?.idempotencyKey).toBe(event.eventKey);
    expect(JSON.stringify(send.mock.calls[0]?.[1])).not.toContain('⚠️ 延迟送达');
    expect(replaceCard).toHaveBeenCalledWith(
      'om_old_first_attempt',
      buildNotificationCard(event, {
        delayed: true,
        timeZone: 'America/New_York',
      }),
    );
    expect(await store.listPendingNotifications()).toEqual([]);
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function createLegacyNotificationDatabase(
  dbPath: string,
  event: CodexNotificationEvent,
  attempts: number,
): Promise<void> {
  const SQL = await initSqlJs({
    locateFile: (file: string) => join(sqlWasmDir, file),
  });
  const db = new SQL.Database();
  db.run(`
    CREATE TABLE notification_deliveries (
      event_key TEXT PRIMARY KEY,
      event_json TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      next_retry_at INTEGER,
      delivered_at INTEGER
    )
  `);
  db.run(
    `INSERT INTO notification_deliveries
       (event_key, event_json, status, attempts, next_retry_at, delivered_at)
     VALUES (?, ?, 'pending', ?, NULL, NULL)`,
    [event.eventKey, JSON.stringify(event), attempts],
  );
  writeFileSync(dbPath, Buffer.from(db.export()));
  db.close();
}
