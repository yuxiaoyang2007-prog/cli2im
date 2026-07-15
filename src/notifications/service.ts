import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SessionStore } from '../session/store.js';
import { readHeadTailWindow } from '../session/file-window.js';
import type { PlatformAdapter } from '../types.js';
import {
  eventKey,
  parseRolloutLine,
  type ParsedRolloutLine,
  type PermissionHookEvent,
} from './codex-events.js';
import {
  NotificationMetadataResolver,
  type NotificationMetadataInput,
} from './metadata.js';
import { CodexEventMonitor } from './monitor.js';
import { NotificationRouter } from './router.js';
import { CodexNotificationSocket } from './socket-server.js';
import type { CodexNotificationEvent, NotificationBinding } from './types.js';

interface NotificationLifecycle {
  start(): Promise<void>;
  stop(): void | Promise<void>;
}

interface NotificationEventRouter {
  resumePending(): Promise<void>;
  handle(event: CodexNotificationEvent): Promise<unknown>;
  stop(): void;
}

interface MetadataResolver {
  resolve(input: NotificationMetadataInput): Promise<{
    projectName: string;
    taskName: string;
    surface: CodexNotificationEvent['surface'];
    shortTaskId: string;
  }>;
}

type RolloutHandler = (
  event: ParsedRolloutLine,
  filePath: string,
) => void | Promise<void>;

type ApprovalHandler = (event: PermissionHookEvent) => void | Promise<void>;

export interface CodexNotificationServiceDependencies {
  router?: NotificationEventRouter;
  metadataResolver?: MetadataResolver;
  createMonitor?: (handler: RolloutHandler) => NotificationLifecycle;
  createSocket?: (handler: ApprovalHandler) => NotificationLifecycle;
  readContextFile?: (filePath: string) => Promise<string>;
  findContextFile?: (sessionsDir: string, sessionId: string) => Promise<string | undefined>;
}

export interface CodexNotificationServiceOptions {
  botName: string;
  workingDirectory: string;
  sessionsDir: string;
  sessionIndexPath: string;
  socketPath: string;
  store: SessionStore;
  resolveAdapter: (botName: string) => PlatformAdapter | undefined;
  timeZone: string;
  now?: () => number;
  dependencies?: CodexNotificationServiceDependencies;
}

interface TurnMetadata {
  cwd?: string;
  userText?: string;
  attachmentName?: string;
}

interface RolloutContext {
  sessionId?: string;
  cwd?: string;
  source?: string;
  turns: Map<string, TurnMetadata>;
}

export class CodexNotificationService {
  readonly botName: string;

  private readonly workingDirectory: string;
  private readonly sessionsDir: string;
  private readonly store: SessionStore;
  private readonly now: () => number;
  private readonly router: NotificationEventRouter;
  private readonly metadataResolver: MetadataResolver;
  private readonly monitor: NotificationLifecycle;
  private readonly socket: NotificationLifecycle;
  private readonly readContextFile: (filePath: string) => Promise<string>;
  private readonly findContextFile: (
    sessionsDir: string,
    sessionId: string,
  ) => Promise<string | undefined>;
  private readonly contextsByFile = new Map<string, RolloutContext>();
  private readonly contextsBySession = new Map<string, RolloutContext>();
  private readonly hydratedFiles = new Set<string>();

  constructor(options: CodexNotificationServiceOptions) {
    this.botName = options.botName;
    this.workingDirectory = options.workingDirectory;
    this.sessionsDir = options.sessionsDir;
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.readContextFile = options.dependencies?.readContextFile ?? readHeadTailWindow;
    this.findContextFile = options.dependencies?.findContextFile ?? findSessionRollout;

    const adapter = options.resolveAdapter(options.botName);
    const adapters = new Map<string, PlatformAdapter>();
    if (adapter) adapters.set(options.botName, adapter);

    this.router = options.dependencies?.router ?? new NotificationRouter({
      store: options.store,
      botName: options.botName,
      adapters,
      timeZone: options.timeZone,
    });
    this.metadataResolver = options.dependencies?.metadataResolver
      ?? new NotificationMetadataResolver({ codexDir: dirname(options.sessionIndexPath) });
    this.monitor = options.dependencies?.createMonitor?.(
      (event, filePath) => this.handleRolloutEvent(event, filePath),
    ) ?? new CodexEventMonitor({
      sessionsDir: options.sessionsDir,
      store: options.store,
      onEvent: (event, filePath) => this.handleRolloutEvent(event, filePath),
    });
    this.socket = options.dependencies?.createSocket?.(
      (event) => this.handleApprovalEvent(event),
    ) ?? new CodexNotificationSocket({
      socketPath: options.socketPath,
      onApproval: (event) => this.handleApprovalEvent(event),
    });
  }

  async start(): Promise<void> {
    await runLifecycleStep('router resume', () => this.router.resumePending());
    await runLifecycleStep('socket start', () => this.socket.start());
    await runLifecycleStep('monitor start', () => this.monitor.start());
  }

  async stop(): Promise<void> {
    await runLifecycleStep('monitor stop', () => this.monitor.stop());
    await runLifecycleStep('socket stop', () => this.socket.stop());
    await runLifecycleStep('router stop', () => this.router.stop());
  }

  async bindTarget(input: Omit<NotificationBinding, 'updatedAt'>): Promise<void> {
    if (input.botName !== this.botName || input.platform !== 'feishu') {
      throw new Error('Invalid notification binding target');
    }
    await this.store.bindNotificationTarget({ ...input, updatedAt: this.now() });
  }

  private async handleRolloutEvent(event: ParsedRolloutLine, filePath: string): Promise<void> {
    let context = this.contextsByFile.get(filePath);
    if (!context) {
      context = { turns: new Map() };
      this.contextsByFile.set(filePath, context);
    }

    if (event.type !== 'session_meta' && !context.sessionId && !this.hydratedFiles.has(filePath)) {
      await this.hydrateContext(filePath, context);
    }
    this.applyContextEvent(context, event);

    if (event.type === 'question') {
      await this.routeRolloutNotification(context, event, {
        eventKey: (sessionId) => eventKey([
          sessionId,
          event.turnId,
          event.requestId,
          'question',
        ]),
        kind: 'needs_attention',
        reason: 'question',
        requestId: event.requestId,
        occurredAt: this.now(),
      });
    } else if (event.type === 'completed') {
      await this.routeRolloutNotification(context, event, {
        eventKey: (sessionId) => eventKey([sessionId, event.turnId, 'completed']),
        kind: 'completed',
        occurredAt: event.occurredAt,
        durationMs: event.durationMs,
      });
      this.releaseContext(filePath, context);
    } else if (event.type === 'aborted') {
      this.releaseContext(filePath, context);
    }
  }

  private async hydrateContext(filePath: string, context: RolloutContext): Promise<void> {
    const content = await this.readContextFile(filePath);
    for (const line of content.split(/\r?\n/)) {
      const parsed = parseRolloutLine(line);
      if (parsed) this.applyContextEvent(context, parsed);
    }
    if (context.sessionId) this.hydratedFiles.add(filePath);
  }

  private applyContextEvent(context: RolloutContext, event: ParsedRolloutLine): void {
    if (event.type === 'session_meta') {
      context.sessionId = event.sessionId;
      context.cwd = event.cwd;
      context.source = event.source;
      this.contextsBySession.set(event.sessionId, context);
      return;
    }

    if (event.type === 'turn_context') {
      const turn = context.turns.get(event.turnId) ?? {};
      turn.cwd = event.cwd;
      context.turns.set(event.turnId, turn);
      return;
    }

    if (event.type === 'user_message') {
      const turn = context.turns.get(event.turnId) ?? {};
      turn.userText = event.userText;
      turn.attachmentName = event.attachmentName;
      context.turns.set(event.turnId, turn);
    }
  }

  private async routeRolloutNotification(
    context: RolloutContext,
    event: Extract<ParsedRolloutLine, { turnId: string }>,
    fields: {
      eventKey: (sessionId: string) => string;
      kind: CodexNotificationEvent['kind'];
      reason?: CodexNotificationEvent['reason'];
      requestId?: string;
      occurredAt: number;
      durationMs?: number;
    },
  ): Promise<void> {
    const sessionId = context.sessionId;
    if (!sessionId) return;
    const metadata = await this.resolveMetadata(context, sessionId, event.turnId);
    await this.router.handle({
      eventKey: fields.eventKey(sessionId),
      kind: fields.kind,
      ...(fields.reason ? { reason: fields.reason } : {}),
      sessionId,
      turnId: event.turnId,
      ...(fields.requestId ? { requestId: fields.requestId } : {}),
      ...metadata,
      occurredAt: fields.occurredAt,
      ...(fields.durationMs === undefined ? {} : { durationMs: fields.durationMs }),
    });
  }

  private async handleApprovalEvent(event: PermissionHookEvent): Promise<void> {
    const context = await this.contextForApproval(event.sessionId);
    const metadata = await this.resolveMetadata(context, event.sessionId, event.turnId);
    await this.router.handle({
      eventKey: eventKey([
        event.sessionId,
        event.turnId,
        event.requestId,
        'approval',
      ]),
      kind: 'needs_attention',
      reason: 'approval',
      sessionId: event.sessionId,
      turnId: event.turnId,
      requestId: event.requestId,
      ...metadata,
      occurredAt: event.occurredAt,
    });
  }

  private async contextForApproval(sessionId: string): Promise<RolloutContext> {
    const existing = this.contextsBySession.get(sessionId);
    if (existing) return existing;

    const filePath = await this.findContextFile(this.sessionsDir, sessionId);
    if (!filePath) return { turns: new Map() };

    let context = this.contextsByFile.get(filePath);
    if (!context) {
      context = { turns: new Map() };
      this.contextsByFile.set(filePath, context);
    }
    await this.hydrateContext(filePath, context);
    return context.sessionId === sessionId ? context : { turns: new Map() };
  }

  private releaseContext(filePath: string, context: RolloutContext): void {
    context.turns.clear();
    if (this.contextsByFile.get(filePath) === context) {
      this.contextsByFile.delete(filePath);
      this.hydratedFiles.delete(filePath);
    }
    if (
      context.sessionId
      && this.contextsBySession.get(context.sessionId) === context
    ) {
      this.contextsBySession.delete(context.sessionId);
    }
  }

  private resolveMetadata(
    context: RolloutContext,
    sessionId: string,
    turnId: string,
  ): ReturnType<MetadataResolver['resolve']> {
    const turn = context.turns.get(turnId);
    return this.metadataResolver.resolve({
      sessionId,
      cwd: turn?.cwd ?? context.cwd ?? this.workingDirectory,
      source: context.source ?? 'unknown',
      userText: turn?.userText ?? '',
      attachmentName: turn?.attachmentName,
    });
  }
}

const MAX_CONTEXT_SEARCH_ENTRIES = 20_000;

async function findSessionRollout(
  sessionsDir: string,
  sessionId: string,
): Promise<string | undefined> {
  const expectedSuffix = `-${sessionId}.jsonl`;
  const pendingDirectories = [sessionsDir];
  let entriesSeen = 0;

  while (pendingDirectories.length > 0 && entriesSeen < MAX_CONTEXT_SEARCH_ENTRIES) {
    const directory = pendingDirectories.pop();
    if (!directory) break;

    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      entriesSeen += 1;
      if (entriesSeen > MAX_CONTEXT_SEARCH_ENTRIES) return undefined;
      const path = join(directory, entry.name);
      if (entry.isFile()
        && entry.name.startsWith('rollout-')
        && entry.name.endsWith(expectedSuffix)) {
        return path;
      }
      if (entry.isDirectory()) pendingDirectories.push(path);
    }
  }
  return undefined;
}

async function runLifecycleStep(
  label: 'router resume' | 'socket start' | 'monitor start' | 'monitor stop' | 'socket stop' | 'router stop',
  operation: () => void | Promise<void>,
): Promise<void> {
  try {
    await operation();
  } catch {
    console.error(`[notifications] ${label} failed`);
  }
}
