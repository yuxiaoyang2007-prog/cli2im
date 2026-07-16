import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { sanitizeMetadataBasename, sanitizeTaskTitle } from './metadata.js';

const EARLIEST_PLAUSIBLE_EPOCH_MS = Date.UTC(2000, 0, 1);
const LATEST_PLAUSIBLE_EPOCH_MS = Date.UTC(2100, 0, 1);

export type ParsedRolloutLine =
  | { type: 'session_meta'; sessionId: string; cwd: string; source: string }
  | { type: 'turn_context'; turnId: string; cwd: string }
  | { type: 'user_message'; turnId: string; userText?: string; attachmentName?: string }
  | { type: 'assistant_state'; turnId: string; awaitingUser: boolean }
  | { type: 'question'; turnId?: string; requestId: string; occurredAt?: number }
  | { type: 'completed'; turnId: string; occurredAt: number; durationMs?: number }
  | { type: 'aborted'; turnId: string };

export interface PermissionHookEvent {
  type: 'approval';
  sessionId: string;
  turnId: string;
  requestId: string;
  occurredAt: number;
}

export function parseRolloutLine(line: string): ParsedRolloutLine | null {
  let outer: unknown;
  try {
    outer = JSON.parse(line) as unknown;
  } catch {
    return null;
  }

  if (!isRecord(outer) || !isRecord(outer.payload)) return null;
  const payload = outer.payload;

  switch (outer.type) {
    case 'session_meta':
      return parseSessionMeta(payload);
    case 'turn_context':
      return parseTurnContext(payload);
    case 'response_item':
      return parseResponseItem(payload, parseIsoTimestamp(outer.timestamp));
    case 'event_msg':
      return parseEventMessage(payload, parseIsoTimestamp(outer.timestamp));
    default:
      return null;
  }
}

export function normalizePermissionHook(input: unknown, now: number): PermissionHookEvent | null {
  if (!isRecord(input) || input.hook_event_name !== 'PermissionRequest' || !Number.isFinite(now)) {
    return null;
  }

  const sessionId = asString(input.session_id);
  const turnId = asString(input.turn_id);
  if (!sessionId || !turnId) return null;

  const toolName = normalizeToolName(input.tool_name);
  const requestId = asString(input.approval_id)
    ?? asString(input.request_id)
    ?? asString(input.tool_use_id)
    ?? eventKey([
      'approval', sessionId, turnId, toolName, String(Math.floor(now / 10_000)),
    ]);

  return {
    type: 'approval',
    sessionId,
    turnId,
    requestId,
    occurredAt: now,
  };
}

export function eventKey(parts: string[]): string {
  return createHash('sha256').update(parts.join('\u001f')).digest('hex').slice(0, 24);
}

function parseSessionMeta(payload: Record<string, unknown>): ParsedRolloutLine | null {
  const sessionId = asString(payload.id);
  const cwd = asString(payload.cwd);
  if (!sessionId || !cwd) return null;
  const source = normalizeSessionSource(payload.source, payload.originator);
  return { type: 'session_meta', sessionId, cwd, source };
}

function parseTurnContext(payload: Record<string, unknown>): ParsedRolloutLine | null {
  const turnId = asString(payload.turn_id);
  const cwd = asString(payload.cwd);
  if (!turnId || !cwd) return null;
  return { type: 'turn_context', turnId, cwd };
}

function parseResponseItem(
  payload: Record<string, unknown>,
  occurredAt: number | undefined,
): ParsedRolloutLine | null {
  if (payload.type === 'function_call' && payload.name === 'request_user_input') {
    const requestId = asString(payload.call_id);
    const turnId = nestedTurnId(payload.internal_chat_message_metadata_passthrough)
      ?? nestedTurnId(payload.metadata);
    return requestId ? {
      type: 'question',
      ...(turnId ? { turnId } : {}),
      requestId,
      ...(occurredAt === undefined ? {} : { occurredAt }),
    } : null;
  }

  const turnId = nestedTurnId(payload.internal_chat_message_metadata_passthrough);
  if (!turnId) return null;

  if (payload.type !== 'message' || !Array.isArray(payload.content)) {
    return null;
  }

  if (payload.role === 'assistant' && payload.phase === 'final_answer') {
    const text = payload.content
      .filter(isRecord)
      .filter((item) => item.type === 'output_text' && typeof item.text === 'string')
      .map((item) => item.text as string)
      .join('\n');
    return text ? {
      type: 'assistant_state',
      turnId,
      awaitingUser: assistantAwaitsUser(text),
    } : null;
  }

  if (payload.role !== 'user') return null;

  let userText = '';
  let attachmentName = '';
  for (const item of payload.content) {
    if (!isRecord(item)) continue;
    if (!userText && item.type === 'input_text' && typeof item.text === 'string') {
      userText = sanitizeTaskTitle(item.text);
    }
    if (!attachmentName && item.type !== 'input_text') {
      attachmentName = safeAttachmentName(item);
    }
  }

  if (!userText && !attachmentName) return null;
  return {
    type: 'user_message',
    turnId,
    ...(userText ? { userText } : {}),
    ...(attachmentName ? { attachmentName } : {}),
  };
}

function assistantAwaitsUser(text: string): boolean {
  const normalized = text.replace(/[\p{C}\p{Z}\s]+/gu, ' ').trim();
  if (!normalized) return false;
  const blocking = [
    /(?:请|需要你|麻烦你|烦请).{0,24}(?:选择|选定|确认|批准|审批|回复|提供|决定)/u,
    /(?:你希望|你想要|你倾向|你选择|你选|选哪|哪一种|哪个方案)/u,
    /(?:先确认|待确认|等待确认|获批后|确认后|选择后|选定后).{0,40}(?:我再|再进入|再继续|继续|开始|执行|实现|制作)/u,
    /(?:回复|告诉)我.{0,24}(?:即可|就行|选择|决定|方案)/u,
    /(?:回复|答复).{1,40}(?:即可|就行|都可以)/u,
    /确认.{0,80}(?:执行|继续|开始|采用|方案).{0,12}(?:吗|么)[？?]?$/u,
    /(?:please\s+(?:choose|confirm|select|reply|provide)|let\s+me\s+know|after\s+you\s+confirm)/iu,
  ].some((pattern) => pattern.test(normalized));
  if (!blocking) return false;

  const delivered = /(?:已|已经).{0,24}(?:完成|生成|创建|修改|修复|导出|上线|部署|发布|保存|写入|交付)/u
    .test(normalized);
  const optionalFollowUp = /(?:如果|如需|若需|需要的话).{0,48}(?:回复|答复|告诉|调整|修改).{0,24}(?:即可|就行|可以)/u
    .test(normalized)
    || /(?:if\s+you(?:'d|\s+would)?\s+like|if\s+you\s+want).{0,80}(?:reply|let\s+me\s+know|adjust|change)/iu
      .test(normalized);
  return !(delivered && optionalFollowUp);
}

function parseEventMessage(
  payload: Record<string, unknown>,
  outerOccurredAt: number | undefined,
): ParsedRolloutLine | null {
  const turnId = asString(payload.turn_id);
  if (!turnId) return null;

  if (payload.type === 'turn_aborted') {
    return { type: 'aborted', turnId };
  }

  if (payload.type !== 'task_complete') return null;
  const occurredAt = outerOccurredAt ?? normalizeCompletionTimestamp(payload.completed_at);
  if (occurredAt === undefined) return null;

  const durationMs = asFiniteNumber(payload.duration_ms);
  return {
    type: 'completed',
    turnId,
    occurredAt,
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}

function normalizeCompletionTimestamp(value: unknown): number | undefined {
  const timestamp = asFiniteNumber(value);
  if (timestamp === undefined) return undefined;
  if (
    timestamp >= EARLIEST_PLAUSIBLE_EPOCH_MS
    && timestamp < LATEST_PLAUSIBLE_EPOCH_MS
  ) return timestamp;
  const milliseconds = timestamp * 1000;
  return (
    milliseconds >= EARLIEST_PLAUSIBLE_EPOCH_MS
    && milliseconds < LATEST_PLAUSIBLE_EPOCH_MS
  ) ? milliseconds : undefined;
}

function nestedTurnId(value: unknown): string | undefined {
  return isRecord(value) ? asString(value.turn_id) : undefined;
}

function safeAttachmentName(item: Record<string, unknown>): string {
  for (const field of ['name', 'filename', 'file_name']) {
    const value = asString(item[field]);
    if (!value) continue;
    return sanitizeMetadataBasename(basename(value.replaceAll('\\', '/')));
  }
  return '';
}

function normalizeSessionSource(source: unknown, originator: unknown): string {
  const normalizedOriginator = typeof originator === 'string'
    ? originator.trim().toLowerCase()
    : '';
  const hasOriginator = normalizedOriginator.length > 0
    || (originator !== undefined && originator !== null && typeof originator !== 'string');

  if (hasOriginator) {
    switch (normalizedOriginator) {
      case 'codex desktop':
        return 'codex-desktop';
      case 'codex_exec':
      case 'codex exec':
      case 'codex-tui':
        return 'cli';
      case 'codex_chrome_sidepanel':
      case 'codex chrome sidepanel':
      case 'codex-chrome-sidepanel':
      case 'chrome sidepanel':
        return 'codex';
      default:
        return 'codex';
    }
  }

  if (isRecord(source)) {
    return Object.hasOwn(source, 'subagent') ? 'subagent' : 'unknown';
  }
  if (typeof source !== 'string') return 'unknown';

  switch (source.trim().toLowerCase()) {
    case 'vscode':
      return 'vscode';
    case 'exec':
    case 'cli':
    case 'codex-cli':
    case 'codex_cli':
      return 'cli';
    case 'codex-desktop':
    case 'codex_desktop':
    case 'desktop':
      return 'codex-desktop';
    case 'chatgpt':
    case 'chatgpt-work':
    case 'chatgpt_work':
    case 'work':
      return 'chatgpt-work';
    case 'ide':
    case 'jetbrains':
      return 'ide';
    case 'codexbot':
    case 'cli2im':
      return 'codexbot';
    case 'subagent':
      return 'subagent';
    default:
      return 'unknown';
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeToolName(value: unknown): string {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/\s+/g, ' ')
    : '';
}

function parseIsoTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return undefined;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  if (
    month < 1 || month > 12
    || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()
    || hour > 23 || minute > 59 || second > 59
    || offsetHour > 23 || offsetMinute > 59
  ) return undefined;

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
