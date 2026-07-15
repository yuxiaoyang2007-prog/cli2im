import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { sanitizeMetadataBasename, sanitizeTaskTitle } from './metadata.js';

const EARLIEST_PLAUSIBLE_EPOCH_MS = Date.UTC(2000, 0, 1);
const LATEST_PLAUSIBLE_EPOCH_MS = Date.UTC(2100, 0, 1);

export type ParsedRolloutLine =
  | { type: 'session_meta'; sessionId: string; cwd: string; source: string }
  | { type: 'turn_context'; turnId: string; cwd: string }
  | { type: 'user_message'; turnId: string; userText?: string; attachmentName?: string }
  | { type: 'question'; turnId: string; requestId: string; occurredAt?: number }
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
  const turnId = passthroughTurnId(payload.internal_chat_message_metadata_passthrough);
  if (!turnId) return null;

  if (payload.type === 'function_call' && payload.name === 'request_user_input') {
    const requestId = asString(payload.call_id);
    return requestId ? {
      type: 'question',
      turnId,
      requestId,
      ...(occurredAt === undefined ? {} : { occurredAt }),
    } : null;
  }

  if (payload.type !== 'message' || payload.role !== 'user' || !Array.isArray(payload.content)) {
    return null;
  }

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

function passthroughTurnId(value: unknown): string | undefined {
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
