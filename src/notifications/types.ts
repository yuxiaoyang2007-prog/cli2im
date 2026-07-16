export type CodexNotificationKind = 'needs_attention' | 'completed';

export type AttentionReason = 'approval' | 'question';

export type CodexSurface =
  | 'ChatGPT Work'
  | 'Codex Desktop'
  | 'CLI'
  | 'IDE'
  | 'codexbot'
  | 'Codex';

export interface CodexNotificationEvent {
  eventKey: string;
  kind: CodexNotificationKind;
  reason?: AttentionReason;
  sessionId: string;
  turnId: string;
  requestId?: string;
  projectName: string;
  taskName: string;
  surface: CodexSurface;
  occurredAt: number;
  durationMs?: number;
  shortTaskId: string;
}

export interface NotificationBinding {
  botName: string;
  platform: 'feishu';
  chatId: string;
  userId: string;
  updatedAt: number;
}

export interface NotificationCursor {
  filePath: string;
  fileId: string;
  byteOffset: number;
  continuityHash?: string;
  updatedAt: number;
}

export interface StoredNotificationDelivery {
  event: CodexNotificationEvent;
  status: 'pending' | 'delivered' | 'failed' | 'discarded';
  attempts: number;
  firstAttemptAt: number | null;
  lastAttemptAt: number | null;
  nextRetryAt: number | null;
  deliveredAt: number | null;
  transportMessageId: string | null;
  acknowledgedAt: number | null;
  delayedPatchCompletedAt: number | null;
}

export type StoredCodexTaskState =
  | 'RUNNING'
  | 'WAITING_APPROVAL'
  | 'WAITING_QUESTION'
  | 'COMPLETED'
  | 'ENDED_UNREPORTED'
  | 'CANCELLED';

export interface StoredCodexTask {
  taskId: string;
  sessionId: string;
  firstTurnId: string;
  currentTurnId: string;
  projectName: string;
  taskName: string;
  state: StoredCodexTaskState;
  createdAt: number;
  updatedAt: number;
}
