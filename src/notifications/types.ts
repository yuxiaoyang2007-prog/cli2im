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
  nextRetryAt: number | null;
  deliveredAt: number | null;
}
