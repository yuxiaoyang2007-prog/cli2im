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
  | 'markNotificationDelivered'
  | 'markNotificationFailed'
  | 'setNotificationDelayed'
  | 'setNotificationNextRetry'
>;

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
  private readonly acceptedInProcess = new Set<string>();
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
    const delayed = this.isDelayed(event);
    if (!await this.store.enqueueNotification(event, delayed)) return 'duplicate';

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
      lastAttemptAt: null,
      nextRetryAt: null,
      deliveredAt: null,
      delayed,
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
      if (this.acceptedInProcess.has(delivery.event.eventKey)) {
        this.scheduleFinalization(delivery, 0, delayMs);
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

    if (delivery.delayed === null) {
      await this.store.markNotificationFailed(event.eventKey);
      this.logFailure(event, attempt, 'card_variant_unverifiable');
      return 'pending';
    }

    const attemptedAt = this.now();
    await this.store.markNotificationAttemptStarted(event.eventKey, attemptedAt);
    const attemptedDelivery: StoredNotificationDelivery = {
      ...delivery,
      attempts: attempt,
      lastAttemptAt: attemptedAt,
      nextRetryAt: null,
    };
    try {
      await adapter.send(chatId, {
        card: buildNotificationCard(event, {
          delayed: delivery.delayed,
          timeZone: this.timeZone,
        }),
      }, { idempotencyKey: event.eventKey });
    } catch (error) {
      return this.handleExternalFailure(attemptedDelivery, classifyError(error));
    }

    this.acceptedInProcess.add(event.eventKey);
    try {
      await this.store.markNotificationDelivered(event.eventKey, this.now());
      this.acceptedInProcess.delete(event.eventKey);
      return 'delivered';
    } catch {
      return this.handleDeliveryStateFailure(attemptedDelivery, 0);
    }
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

  private async handleDeliveryStateFailure(
    delivery: StoredNotificationDelivery,
    retryIndex: number,
  ): Promise<NotificationHandleResult> {
    const { event, attempts } = delivery;
    this.logFailure(event, attempts, 'delivery_state_error');
    if (retryIndex >= RETRY_DELAYS_MS.length) {
      await this.store.setNotificationNextRetry(event.eventKey, null);
      return 'pending';
    }

    const retryDelayMs = RETRY_DELAYS_MS[retryIndex];
    const nextRetryAt = this.now() + retryDelayMs;
    await this.store.setNotificationNextRetry(event.eventKey, nextRetryAt);
    this.scheduleFinalization({ ...delivery, nextRetryAt }, retryIndex, retryDelayMs);
    return 'pending';
  }

  private async finalizeDelivery(
    delivery: StoredNotificationDelivery,
    retryIndex: number,
  ): Promise<NotificationHandleResult> {
    try {
      await this.store.markNotificationDelivered(delivery.event.eventKey, this.now());
      this.acceptedInProcess.delete(delivery.event.eventKey);
      return 'delivered';
    } catch {
      return this.handleDeliveryStateFailure(delivery, retryIndex + 1);
    }
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
        return prepared ? this.attemptDelivery(prepared) : 'pending';
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

  private scheduleFinalization(
    delivery: StoredNotificationDelivery,
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
        this.finalizeDelivery(delivery, retryIndex)
      ));
      this.timers.delete(eventKey);
      if (!operation) {
        const active = this.inFlight.get(eventKey);
        void active?.then(
          () => this.scheduleFinalization(delivery, retryIndex, 0),
          () => this.scheduleFinalization(delivery, retryIndex, 0),
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
    if (this.acceptedInProcess.has(eventKey)) {
      this.scheduleFinalization(delivery, 0, delayMs);
      return;
    }
    this.scheduleDelivery(delivery, delayMs);
  }

  private async preparePendingDelivery(
    delivery: StoredNotificationDelivery,
  ): Promise<StoredNotificationDelivery | null> {
    const { event, attempts, lastAttemptAt } = delivery;
    if (attempts >= MAX_ATTEMPTS) {
      await this.store.markNotificationFailed(event.eventKey);
      return null;
    }

    if (attempts > 0) {
      if (
        delivery.delayed === null
        || lastAttemptAt === null
        || !Number.isFinite(lastAttemptAt)
        || lastAttemptAt > this.now()
      ) {
        await this.store.markNotificationFailed(event.eventKey);
        this.logFailure(event, attempts, 'idempotency_unverifiable');
        return null;
      }
      if (this.now() - lastAttemptAt >= UUID_SAFETY_WINDOW_MS) {
        await this.store.markNotificationFailed(event.eventKey);
        this.logFailure(event, attempts, 'idempotency_expired');
        return null;
      }
      return delivery;
    }

    if (delivery.delayed !== null) return delivery;
    const delayed = this.isDelayed(event);
    await this.store.setNotificationDelayed(event.eventKey, delayed);
    return { ...delivery, delayed };
  }

  private isDelayed(event: CodexNotificationEvent): boolean {
    return this.now() - event.occurredAt > DELAYED_AFTER_MS;
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
