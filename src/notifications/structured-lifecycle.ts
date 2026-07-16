import { createHash } from 'node:crypto';
import type { SessionStore } from '../session/store.js';
import type { StructuredLifecycleEvent } from './lifecycle-protocol.js';
import type {
  CodexNotificationEvent,
  StoredCodexTask,
  StoredCodexTaskState,
} from './types.js';

export type StructuredHandleResult =
  | 'delivered'
  | 'duplicate'
  | 'discarded'
  | 'failed'
  | 'pending'
  | 'ignored';

interface StructuredRouter {
  handle(event: CodexNotificationEvent): Promise<Exclude<StructuredHandleResult, 'ignored'> | unknown>;
}

export class StructuredLifecycleService {
  private readonly store: Pick<SessionStore, 'getLatestCodexTask' | 'upsertCodexTask'>;
  private readonly router: StructuredRouter;

  constructor(options: { store: SessionStore; router: StructuredRouter }) {
    this.store = options.store;
    this.router = options.router;
  }

  async handle(event: StructuredLifecycleEvent): Promise<StructuredHandleResult> {
    if (event.type === 'user_prompt') return this.handleUserPrompt(event);
    const task = await this.store.getLatestCodexTask(event.sessionId);
    if (!task || task.currentTurnId !== event.turnId) return 'ignored';
    if (event.type === 'subagent_start' || event.type === 'subagent_stop') return 'ignored';
    if (task.state === 'COMPLETED' || task.state === 'CANCELLED') return 'duplicate';

    if (event.type === 'approval_requested') {
      return this.notifyAndTransition(task, event, 'WAITING_APPROVAL', {
        kind: 'needs_attention', reason: 'approval', requestId: event.requestId,
      });
    }
    if (event.type === 'status_tool') {
      if (event.status === 'completed') {
        return this.notifyAndTransition(task, event, 'COMPLETED', { kind: 'completed' });
      }
      return this.notifyAndTransition(
        task,
        event,
        event.reason === 'confirmation' ? 'WAITING_APPROVAL' : 'WAITING_QUESTION',
        { kind: 'needs_attention', reason: event.reason === 'confirmation' ? 'approval' : 'question' },
      );
    }
    if (event.type === 'stop' && event.stopHookActive && task.state === 'RUNNING') {
      await this.transition(task, 'ENDED_UNREPORTED', event.occurredAt);
    }
    return 'ignored';
  }

  private async handleUserPrompt(
    event: Extract<StructuredLifecycleEvent, { type: 'user_prompt' }>,
  ): Promise<StructuredHandleResult> {
    const latest = await this.store.getLatestCodexTask(event.sessionId);
    const resumes = latest && (latest.state === 'WAITING_APPROVAL' || latest.state === 'WAITING_QUESTION');
    const task: StoredCodexTask = resumes ? {
      ...latest,
      currentTurnId: event.turnId,
      state: 'RUNNING',
      updatedAt: event.occurredAt,
    } : {
      taskId: createHash('sha256').update(`${event.sessionId}\u001f${event.turnId}`).digest('hex'),
      sessionId: event.sessionId,
      firstTurnId: event.turnId,
      currentTurnId: event.turnId,
      projectName: event.projectName,
      taskName: event.taskName,
      state: 'RUNNING',
      createdAt: event.occurredAt,
      updatedAt: event.occurredAt,
    };
    await this.store.upsertCodexTask(task);
    return 'ignored';
  }

  private async notifyAndTransition(
    task: StoredCodexTask,
    event: StructuredLifecycleEvent,
    state: StoredCodexTaskState,
    notification: Pick<CodexNotificationEvent, 'kind'>
      & Partial<Pick<CodexNotificationEvent, 'reason' | 'requestId'>>,
  ): Promise<StructuredHandleResult> {
    if (!task.projectName || !task.taskName) return 'ignored';
    const result = await this.router.handle({
      eventKey: event.eventKey,
      kind: notification.kind,
      ...(notification.reason ? { reason: notification.reason } : {}),
      ...(notification.requestId ? { requestId: notification.requestId } : {}),
      sessionId: task.sessionId,
      turnId: event.turnId,
      projectName: task.projectName,
      taskName: task.taskName,
      surface: 'Codex',
      occurredAt: event.occurredAt,
      shortTaskId: task.taskId.slice(0, 8),
    });
    if (result === 'failed') return 'failed';
    await this.transition(task, state, event.occurredAt);
    return isHandleResult(result) ? result : 'pending';
  }

  private async transition(
    task: StoredCodexTask,
    state: StoredCodexTaskState,
    updatedAt: number,
  ): Promise<void> {
    await this.store.upsertCodexTask({ ...task, state, updatedAt });
  }
}

function isHandleResult(value: unknown): value is Exclude<StructuredHandleResult, 'ignored'> {
  return value === 'delivered'
    || value === 'duplicate'
    || value === 'discarded'
    || value === 'failed'
    || value === 'pending';
}
