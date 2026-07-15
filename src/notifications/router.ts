import type { SessionStore } from '../session/store.js';
import type { PlatformAdapter } from '../types.js';
import { buildNotificationCard } from './card.js';
import type {
  CodexNotificationEvent,
  StoredNotificationDelivery,
} from './types.js';

const RETRY_DELAYS_MS = [1_000, 5_000, 20_000] as const;
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
const DELAYED_AFTER_MS = 30_000;
const UUID_SAFETY_WINDOW_MS = 55 * 60_000;
const SHORT_EVENT_KEY_LENGTH = 8;

type Timer = ReturnType<typeof globalThis.setTimeout>;

type NotificationStore = Pick<SessionStore,
  | 'enqueueNotification'
  | 'getNotificationBinding'
  | 'listPendingNotifications'
  | 'markNotificationAttemptStarted'
  | 'markNotificationDelayedPatchCompleted'
  | 'markNotificationDelivered'
  | 'markNotificationFailed'
  | 'recordNotificationReceipt'
  | 'setNotificationNextRetry'
>;

interface TransportReceipt {
  messageId: string;
  acknowledgedAt: number;
  delayedPatchCompletedAt: number | null;
}

export interface NotificationLogEntry {
  kind: CodexNotificationEvent['kind'];
  eventKey: string;
  attempt: number;
  errorClass: string;
}

export interface NotificationRouterOptions {
  store: NotificationStore;
  botName: string;
  adapters: ReadonlyMap<string, PlatformAdapter>;
  timeZone: string;
  now?: () => number;
  setTimeout?: (callback: () => void, delayMs: number) => Timer;
  clearTimeout?: (timer: Timer) => void;
  log?: (entry: NotificationLogEntry) => void;
}

export type NotificationHandleResult =
  | 'delivered'
  | 'duplicate'
  | 'discarded'
  | 'pending';

export class NotificationRouter {
  private readonly store: NotificationStore;
  private readonly botName: string;
  private readonly adapters: ReadonlyMap<string, PlatformAdapter>;
  private readonly timeZone: string;
  private readonly now: () => number;
  private readonly scheduleTimeout: (callback: () => void, delayMs: number) => Timer;
  private readonly cancelTimeout: (timer: Timer) => void;
  private readonly logger: (entry: NotificationLogEntry) => void;
  private readonly timers = new Map<string, Timer>();
  private readonly inFlight = new Map<string, Promise<NotificationHandleResult>>();
  private readonly acceptedInProcess = new Map<string, TransportReceipt>();
  private stopped = false;

  constructor(options: NotificationRouterOptions) {
    this.store = options.store;
    this.botName = options.botName;
    this.adapters = options.adapters;
    this.timeZone = options.timeZone;
    this.now = options.now ?? Date.now;
    this.scheduleTimeout = options.setTimeout ?? globalThis.setTimeout;
    this.cancelTimeout = options.clearTimeout ?? globalThis.clearTimeout;
    this.logger = options.log ?? logNotificationFailure;
  }

  async handle(event: CodexNotificationEvent): Promise<NotificationHandleResult> {
    const safeEvent = allowlistedEvent(event);
    const operation = this.beginInFlight(safeEvent.eventKey, () => this.handleNew(safeEvent));
    return operation ?? 'duplicate';
  }

  private async handleNew(event: CodexNotificationEvent): Promise<NotificationHandleResult> {
    if (!await this.store.enqueueNotification(event)) return 'duplicate';

    const binding = await this.store.getNotificationBinding(this.botName);
    if (!binding) {
      await this.store.markNotificationFailed(event.eventKey, 'discarded');
      this.logFailure(event, 1, 'binding_unavailable');
      return 'discarded';
    }

    const adapter = this.resolveFeishuAdapter(binding.botName, binding.platform);
    if (!adapter) {
      await this.store.markNotificationFailed(event.eventKey);
      this.logFailure(event, 1, 'adapter_unavailable');
      return 'pending';
    }

    return this.attemptDelivery({
      event,
      status: 'pending',
      attempts: 0,
      firstAttemptAt: null,
      lastAttemptAt: null,
      nextRetryAt: null,
      deliveredAt: null,
      transportMessageId: null,
      acknowledgedAt: null,
      delayedPatchCompletedAt: null,
    }, binding.chatId, adapter);
  }

  async resumePending(): Promise<void> {
    if (this.stopped) return;
    const deliveries = await this.store.listPendingNotifications();
    for (const storedDelivery of deliveries) {
      if (this.inFlight.has(storedDelivery.event.eventKey)) continue;
      const delivery = await this.preparePendingDelivery(storedDelivery);
      if (!delivery) continue;
      const delayMs = delivery.nextRetryAt === null
        ? 0
        : Math.max(0, delivery.nextRetryAt - this.now());
      const receipt = this.receiptFor(delivery);
      if (receipt) {
        this.scheduleContinuation(delivery, receipt, 0, delayMs);
        continue;
      }
      this.scheduleDelivery(delivery, delayMs);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) this.cancelTimeout(timer);
    this.timers.clear();
  }

  private async attemptDelivery(
    delivery: StoredNotificationDelivery,
    knownChatId?: string,
    knownAdapter?: PlatformAdapter,
  ): Promise<NotificationHandleResult> {
    const { event } = delivery;
    const attempt = delivery.attempts + 1;
    const binding = knownChatId === undefined
      ? await this.store.getNotificationBinding(this.botName)
      : null;
    const chatId = knownChatId ?? binding?.chatId;

    if (!chatId) {
      await this.store.markNotificationFailed(event.eventKey, 'discarded');
      this.logFailure(event, attempt, 'binding_unavailable');
      return 'discarded';
    }

    const adapter = knownAdapter
      ?? this.resolveFeishuAdapter(binding?.botName, binding?.platform);
    if (!adapter) {
      await this.store.markNotificationFailed(event.eventKey);
      this.logFailure(event, attempt, 'adapter_unavailable');
      return 'pending';
    }

    const attemptedAt = this.now();
    await this.store.markNotificationAttemptStarted(event.eventKey, attemptedAt);
    const attemptedDelivery: StoredNotificationDelivery = {
      ...delivery,
      attempts: attempt,
      firstAttemptAt: delivery.firstAttemptAt ?? attemptedAt,
      lastAttemptAt: attemptedAt,
      nextRetryAt: null,
    };
    let messageId: string;
    try {
      messageId = await adapter.send(chatId, {
        card: buildNotificationCard(event, {
          delayed: false,
          timeZone: this.timeZone,
        }),
      }, { idempotencyKey: event.eventKey });
    } catch (error) {
      return this.handleExternalFailure(attemptedDelivery, classifyError(error));
    }

    const receipt: TransportReceipt = {
      messageId,
      acknowledgedAt: this.now(),
      delayedPatchCompletedAt: null,
    };
    this.acceptedInProcess.set(event.eventKey, receipt);
    return this.continueAcceptedDelivery(attemptedDelivery, receipt, 0, adapter);
  }

  private async handleExternalFailure(
    delivery: StoredNotificationDelivery,
    errorClass: string,
  ): Promise<NotificationHandleResult> {
    const { event, attempts } = delivery;
    if (attempts >= MAX_ATTEMPTS) {
      await this.store.markNotificationFailed(event.eventKey);
      this.logFailure(event, attempts, errorClass);
      return 'pending';
    }

    const retryDelayMs = RETRY_DELAYS_MS[attempts - 1];
    const nextRetryAt = this.now() + retryDelayMs;
    await this.store.setNotificationNextRetry(event.eventKey, nextRetryAt);
    this.logFailure(event, attempts, errorClass);
    this.scheduleDelivery({
      ...delivery,
      nextRetryAt,
    }, retryDelayMs);
    return 'pending';
  }

  private async continueAcceptedDelivery(
    delivery: StoredNotificationDelivery,
    receipt: TransportReceipt,
    retryIndex: number,
    knownAdapter?: PlatformAdapter,
  ): Promise<NotificationHandleResult> {
    const { event } = delivery;
    let current = delivery;

    if (
      current.transportMessageId !== receipt.messageId
      || current.acknowledgedAt !== receipt.acknowledgedAt
    ) {
      try {
        await this.store.recordNotificationReceipt(
          event.eventKey,
          receipt.messageId,
          receipt.acknowledgedAt,
        );
        current = {
          ...current,
          transportMessageId: receipt.messageId,
          acknowledgedAt: receipt.acknowledgedAt,
          nextRetryAt: null,
        };
      } catch {
        return this.handleLocalFailure(current, receipt, retryIndex, 'receipt_state_error');
      }
    }

    if (this.receiptWasDelayed(event, receipt)) {
      if (
        receipt.delayedPatchCompletedAt === null
        && current.delayedPatchCompletedAt === null
      ) {
        const adapter = knownAdapter ?? await this.getBoundFeishuAdapter();
        if (!adapter?.replaceCard) {
          return this.handleLocalFailure(current, receipt, retryIndex, 'patch_adapter_unavailable');
        }
        try {
          await adapter.replaceCard(
            receipt.messageId,
            buildNotificationCard(event, {
              delayed: true,
              timeZone: this.timeZone,
            }),
          );
        } catch (error) {
          return this.handleLocalFailure(current, receipt, retryIndex, classifyError(error));
        }
        receipt = {
          ...receipt,
          delayedPatchCompletedAt: this.now(),
        };
        this.acceptedInProcess.set(event.eventKey, receipt);
      }

      if (current.delayedPatchCompletedAt === null) {
        const completedAt = receipt.delayedPatchCompletedAt;
        if (completedAt === null) {
          return this.handleLocalFailure(current, receipt, retryIndex, 'patch_state_error');
        }
        try {
          await this.store.markNotificationDelayedPatchCompleted(event.eventKey, completedAt);
          current = {
            ...current,
            delayedPatchCompletedAt: completedAt,
            nextRetryAt: null,
          };
        } catch {
          return this.handleLocalFailure(current, receipt, retryIndex, 'patch_state_error');
        }
      }
    }

    try {
      await this.store.markNotificationDelivered(event.eventKey, this.now());
      this.acceptedInProcess.delete(event.eventKey);
      return 'delivered';
    } catch {
      return this.handleLocalFailure(current, receipt, retryIndex, 'delivery_state_error');
    }
  }

  private async handleLocalFailure(
    delivery: StoredNotificationDelivery,
    receipt: TransportReceipt,
    retryIndex: number,
    errorClass: string,
  ): Promise<NotificationHandleResult> {
    const { event, attempts } = delivery;
    this.logFailure(event, attempts, errorClass);
    if (retryIndex >= RETRY_DELAYS_MS.length) {
      await this.store.setNotificationNextRetry(event.eventKey, null);
      return 'pending';
    }

    const retryDelayMs = RETRY_DELAYS_MS[retryIndex];
    const nextRetryAt = this.now() + retryDelayMs;
    await this.store.setNotificationNextRetry(event.eventKey, nextRetryAt);
    this.scheduleContinuation(
      { ...delivery, nextRetryAt },
      receipt,
      retryIndex + 1,
      retryDelayMs,
    );
    return 'pending';
  }

  private scheduleDelivery(delivery: StoredNotificationDelivery, delayMs: number): void {
    if (this.stopped || this.timers.has(delivery.event.eventKey)) return;
    const timer = this.scheduleTimeout(() => {
      const eventKey = delivery.event.eventKey;
      if (this.stopped) {
        this.timers.delete(eventKey);
        return;
      }
      const operation = this.beginInFlight(eventKey, async () => {
        const prepared = await this.preparePendingDelivery(delivery);
        if (!prepared) return 'pending';
        const receipt = this.receiptFor(prepared);
        return receipt
          ? this.continueAcceptedDelivery(prepared, receipt, 0)
          : this.attemptDelivery(prepared);
      });
      this.timers.delete(eventKey);
      if (!operation) {
        this.resumeAfterInFlight(eventKey);
        return;
      }
      void operation.catch((error: unknown) => {
        this.logFailure(delivery.event, delivery.attempts + 1, 'router_state_error');
      });
    }, delayMs);
    this.timers.set(delivery.event.eventKey, timer);
  }

  private scheduleContinuation(
    delivery: StoredNotificationDelivery,
    receipt: TransportReceipt,
    retryIndex: number,
    delayMs: number,
  ): void {
    const eventKey = delivery.event.eventKey;
    if (this.stopped || this.timers.has(eventKey)) return;
    const timer = this.scheduleTimeout(() => {
      if (this.stopped) {
        this.timers.delete(eventKey);
        return;
      }
      const operation = this.beginInFlight(eventKey, () => (
        this.continueAcceptedDelivery(delivery, receipt, retryIndex)
      ));
      this.timers.delete(eventKey);
      if (!operation) {
        const active = this.inFlight.get(eventKey);
        void active?.then(
          () => this.scheduleContinuation(delivery, receipt, retryIndex, 0),
          () => this.scheduleContinuation(delivery, receipt, retryIndex, 0),
        );
        return;
      }
      void operation.catch(() => {
        this.logFailure(delivery.event, delivery.attempts, 'router_state_error');
      });
    }, delayMs);
    this.timers.set(eventKey, timer);
  }

  private beginInFlight(
    eventKey: string,
    operation: () => Promise<NotificationHandleResult>,
  ): Promise<NotificationHandleResult> | null {
    if (this.inFlight.has(eventKey)) return null;
    const promise = Promise.resolve().then(operation);
    this.inFlight.set(eventKey, promise);
    void promise.then(
      () => this.clearInFlight(eventKey, promise),
      () => this.clearInFlight(eventKey, promise),
    );
    return promise;
  }

  private clearInFlight(eventKey: string, promise: Promise<NotificationHandleResult>): void {
    if (this.inFlight.get(eventKey) === promise) this.inFlight.delete(eventKey);
  }

  private resumeAfterInFlight(eventKey: string): void {
    const active = this.inFlight.get(eventKey);
    if (!active) return;
    void active.then(
      () => this.schedulePersistedEvent(eventKey),
      () => this.schedulePersistedEvent(eventKey),
    );
  }

  private async schedulePersistedEvent(eventKey: string): Promise<void> {
    if (this.stopped) return;
    const storedDelivery = (await this.store.listPendingNotifications())
      .find((candidate) => candidate.event.eventKey === eventKey);
    if (!storedDelivery || this.inFlight.has(eventKey)) return;
    const delivery = await this.preparePendingDelivery(storedDelivery);
    if (!delivery) return;
    const delayMs = delivery.nextRetryAt === null
      ? 0
      : Math.max(0, delivery.nextRetryAt - this.now());
    const receipt = this.receiptFor(delivery);
    if (receipt) {
      this.scheduleContinuation(delivery, receipt, 0, delayMs);
      return;
    }
    this.scheduleDelivery(delivery, delayMs);
  }

  private async preparePendingDelivery(
    delivery: StoredNotificationDelivery,
  ): Promise<StoredNotificationDelivery | null> {
    const { event, attempts, firstAttemptAt } = delivery;
    if (this.acceptedInProcess.has(event.eventKey)) return delivery;

    const hasPersistedReceipt = delivery.transportMessageId !== null
      || delivery.acknowledgedAt !== null
      || delivery.delayedPatchCompletedAt !== null;
    if (hasPersistedReceipt) {
      if (this.receiptFor(delivery)) return delivery;
      await this.store.markNotificationFailed(event.eventKey);
      this.logFailure(event, attempts, 'transport_receipt_unverifiable');
      return null;
    }

    if (attempts >= MAX_ATTEMPTS) {
      await this.store.markNotificationFailed(event.eventKey);
      return null;
    }

    if (attempts > 0) {
      if (
        firstAttemptAt === null
        || !Number.isFinite(firstAttemptAt)
        || firstAttemptAt > this.now()
      ) {
        await this.store.markNotificationFailed(event.eventKey);
        this.logFailure(event, attempts, 'idempotency_unverifiable');
        return null;
      }
      if (this.now() - firstAttemptAt >= UUID_SAFETY_WINDOW_MS) {
        await this.store.markNotificationFailed(event.eventKey);
        this.logFailure(event, attempts, 'idempotency_expired');
        return null;
      }
      return delivery;
    }

    return delivery;
  }

  private receiptFor(delivery: StoredNotificationDelivery): TransportReceipt | null {
    const accepted = this.acceptedInProcess.get(delivery.event.eventKey);
    if (accepted) return accepted;
    if (
      typeof delivery.transportMessageId !== 'string'
      || delivery.transportMessageId.length === 0
      || delivery.acknowledgedAt === null
      || !Number.isFinite(delivery.acknowledgedAt)
      || (
        delivery.delayedPatchCompletedAt !== null
        && !Number.isFinite(delivery.delayedPatchCompletedAt)
      )
    ) return null;
    return {
      messageId: delivery.transportMessageId,
      acknowledgedAt: delivery.acknowledgedAt,
      delayedPatchCompletedAt: delivery.delayedPatchCompletedAt,
    };
  }

  private receiptWasDelayed(
    event: CodexNotificationEvent,
    receipt: TransportReceipt,
  ): boolean {
    return receipt.acknowledgedAt - event.occurredAt > DELAYED_AFTER_MS;
  }

  private async getBoundFeishuAdapter(): Promise<PlatformAdapter | undefined> {
    const binding = await this.store.getNotificationBinding(this.botName);
    return this.resolveFeishuAdapter(binding?.botName, binding?.platform);
  }

  private resolveFeishuAdapter(
    bindingBotName: string | undefined,
    bindingPlatform: string | undefined,
  ): PlatformAdapter | undefined {
    if (bindingBotName !== this.botName || bindingPlatform !== 'feishu') return undefined;
    const adapter = this.adapters.get(this.botName);
    return adapter?.name === 'feishu' ? adapter : undefined;
  }

  private logFailure(
    event: CodexNotificationEvent,
    attempt: number,
    errorClass: string,
  ): void {
    this.logger({
      kind: event.kind,
      eventKey: event.eventKey.slice(0, SHORT_EVENT_KEY_LENGTH),
      attempt,
      errorClass,
    });
  }
}

function allowlistedEvent(event: CodexNotificationEvent): CodexNotificationEvent {
  return {
    eventKey: event.eventKey,
    kind: event.kind,
    ...(event.reason === undefined ? {} : { reason: event.reason }),
    sessionId: event.sessionId,
    turnId: event.turnId,
    ...(event.requestId === undefined ? {} : { requestId: event.requestId }),
    projectName: event.projectName,
    taskName: event.taskName,
    surface: event.surface,
    occurredAt: event.occurredAt,
    ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
    shortTaskId: event.shortTaskId,
  };
}

function classifyError(error: unknown): string {
  if (error instanceof TypeError) return 'TypeError';
  if (error instanceof RangeError) return 'RangeError';
  if (error instanceof SyntaxError) return 'SyntaxError';
  if (error instanceof Error) return 'Error';
  return 'unknown';
}

function logNotificationFailure(entry: NotificationLogEntry): void {
  console.warn(
    `[notification] kind=${entry.kind} event=${entry.eventKey} attempt=${entry.attempt} error=${entry.errorClass}`,
  );
}
