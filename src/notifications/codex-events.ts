import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { sanitizeMetadataBasename, sanitizeTaskTitle } from './metadata.js';

export type ParsedRolloutLine =
  | { type: 'session_meta'; sessionId: string; cwd: string; source: string }
  | { type: 'turn_context'; turnId: string; cwd: string }
  | { type: 'user_message'; turnId: string; userText?: string; attachmentName?: string }
  | { type: 'question'; turnId: string; requestId: string }
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
      return parseResponseItem(payload);
    case 'event_msg':
      return parseEventMessage(payload);
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

  const requestId = asString(input.approval_id)
    ?? asString(input.request_id)
    ?? asString(input.tool_use_id)
    ?? eventKey(['approval', sessionId, turnId, String(Math.floor(now / 10_000))]);

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

function parseResponseItem(payload: Record<string, unknown>): ParsedRolloutLine | null {
  const turnId = passthroughTurnId(payload.internal_chat_message_metadata_passthrough);
  if (!turnId) return null;

  if (payload.type === 'function_call' && payload.name === 'request_user_input') {
    const requestId = asString(payload.call_id);
    return requestId ? { type: 'question', turnId, requestId } : null;
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

function parseEventMessage(payload: Record<string, unknown>): ParsedRolloutLine | null {
  const turnId = asString(payload.turn_id);
  if (!turnId) return null;

  if (payload.type === 'turn_aborted') {
    return { type: 'aborted', turnId };
  }

  if (payload.type !== 'task_complete') return null;
  const occurredAt = asFiniteNumber(payload.completed_at);
  if (occurredAt === undefined) return null;

  const durationMs = asFiniteNumber(payload.duration_ms);
  return {
    type: 'completed',
    turnId,
    occurredAt,
    ...(durationMs === undefined ? {} : { durationMs }),
  };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
