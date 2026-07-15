import type { CardPayload } from '../types.js';
import type { CodexNotificationEvent } from './types.js';

export interface NotificationCardOptions {
  delayed: boolean;
  timeZone: string;
}

export function buildNotificationCard(
  event: CodexNotificationEvent,
  options: NotificationCardOptions,
): CardPayload {
  const value = (input: string) => normalizeFeishuPlainText(input);
  const commonLines = [
    `**项目：** ${value(event.projectName)}`,
    `**任务：** ${value(event.taskName)}`,
  ];

  const card = event.kind === 'needs_attention'
    ? {
        type: 'final' as const,
        title: '🟠 待你处理',
        headerTemplate: 'orange' as const,
        content: [
          ...commonLines,
          `**原因：** ${value(attentionReason(event))}`,
          `**位置：** ${value(event.surface)}`,
          `**时间：** ${value(formatTime(event.occurredAt, options.timeZone))}`,
          `**任务 ID：** ${value(event.shortTaskId)}`,
        ],
      }
    : {
        type: 'final' as const,
        title: '🟢 任务完成',
        headerTemplate: 'green' as const,
        content: [
          ...commonLines,
          `**位置：** ${value(event.surface)}`,
          `**完成：** ${value(formatTime(event.occurredAt, options.timeZone))}`,
          `**耗时：** ${value(
            event.durationMs === undefined ? '未知' : formatDuration(event.durationMs)
          )}`,
          `**任务 ID：** ${value(event.shortTaskId)}`,
        ],
      };

  if (options.delayed) card.content.push('⚠️ 延迟送达');
  return { ...card, content: card.content.join('\n') };
}

function attentionReason(event: CodexNotificationEvent): string {
  return event.reason === 'question' ? '需要回答问题' : '需要批准操作';
}

function formatTime(timestamp: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(timestamp));
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
}

function normalizeFeishuPlainText(input: string): string {
  return input
    .replace(/[\p{C}\p{Z}\s]+/gu, ' ')
    .trim()
    .replaceAll('<', '＜')
    .replaceAll('>', '＞')
    .replace(/([\\`*_{}[\]()#+\-.!|~])/g, '\\$1');
}
