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
const SHORT_EVENT_KEY_LENGTH = 8;

type Timer = ReturnType<typeof globalThis.setTimeout>;

type NotificationStore = Pick<SessionStore,
  | 'enqueueNotification'
  | 'getNotificationBinding'
  | 'listPendingNotifications'
  | 'markNotificationAttempt'
  | 'markNotificationDelivered'
  | 'markNotificationFailed'
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

    return this.attemptDelivery(event, 0, binding.chatId, adapter);
  }

  async resumePending(): Promise<void> {
    if (this.stopped) return;
    const deliveries = await this.store.listPendingNotifications();
    for (const delivery of deliveries) {
      if (this.inFlight.has(delivery.event.eventKey)) continue;
      if (delivery.attempts >= MAX_ATTEMPTS) {
        await this.store.markNotificationFailed(delivery.event.eventKey);
        continue;
      }
      const delayMs = delivery.nextRetryAt === null
        ? 0
        : Math.max(0, delivery.nextRetryAt - this.now());
      this.scheduleDelivery(delivery, delayMs);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) this.cancelTimeout(timer);
    this.timers.clear();
  }

  private async attemptDelivery(
    event: CodexNotificationEvent,
    previousAttempts: number,
    knownChatId?: string,
    knownAdapter?: PlatformAdapter,
  ): Promise<NotificationHandleResult> {
    const attempt = previousAttempts + 1;
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

    const delayed = this.now() - event.occurredAt > DELAYED_AFTER_MS;
    try {
      await adapter.send(chatId, {
        card: buildNotificationCard(event, { delayed, timeZone: this.timeZone }),
      }, { idempotencyKey: event.eventKey });
    } catch (error) {
      return this.handleAttemptFailure(event, previousAttempts, classifyError(error));
    }

    try {
      await this.store.markNotificationDelivered(event.eventKey, this.now());
      return 'delivered';
    } catch {
      return this.handleAttemptFailure(event, previousAttempts, 'delivery_state_error');
    }
  }

  private async handleAttemptFailure(
    event: CodexNotificationEvent,
    previousAttempts: number,
    errorClass: string,
  ): Promise<NotificationHandleResult> {
    const attempt = previousAttempts + 1;
    if (attempt >= MAX_ATTEMPTS) {
      await this.store.markNotificationAttempt(event.eventKey, null);
      await this.store.markNotificationFailed(event.eventKey);
      this.logFailure(event, attempt, errorClass);
      return 'pending';
    }

    const retryDelayMs = RETRY_DELAYS_MS[previousAttempts];
    const nextRetryAt = this.now() + retryDelayMs;
    await this.store.markNotificationAttempt(event.eventKey, nextRetryAt);
    this.logFailure(event, attempt, errorClass);
    this.scheduleDelivery({
      event,
      status: 'pending',
      attempts: attempt,
      nextRetryAt,
      deliveredAt: null,
    }, retryDelayMs);
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
      const operation = this.beginInFlight(eventKey, () => (
        this.attemptDelivery(delivery.event, delivery.attempts)
      ));
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
    const delivery = (await this.store.listPendingNotifications())
      .find((candidate) => candidate.event.eventKey === eventKey);
    if (!delivery || this.inFlight.has(eventKey)) return;
    const delayMs = delivery.nextRetryAt === null
      ? 0
      : Math.max(0, delivery.nextRetryAt - this.now());
    this.scheduleDelivery(delivery, delayMs);
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
