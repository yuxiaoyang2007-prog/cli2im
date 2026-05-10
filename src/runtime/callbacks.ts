import type { BotConfig, CallbackQuery } from '../types.js';

type PermissionDecision = 'allow' | 'allow_session' | 'deny';

export interface PermissionCallbackData {
  decision: PermissionDecision;
  requestId: string;
}

export interface PermissionAgentManager {
  approvePermission(requestId: string): boolean;
  denyPermission(requestId: string): boolean;
}

export interface SessionResumeCallbackData {
  action: 'resume_cli';
  sessionId: string;
  cwd: string;
}

export function isCallbackAuthorized(callback: CallbackQuery, botConfig: BotConfig): boolean {
  const isGroup = isGroupCallback(callback);
  const normalizedAllowList = botConfig.allowFrom.map(String);
  const userAllowed = normalizedAllowList.includes('*') || normalizedAllowList.includes(callback.userId);
  if (!userAllowed) return false;

  if (isGroup && botConfig.groupPolicy === 'allowlist') {
    return (botConfig.groupAllowFrom ?? []).map(String).includes(callback.chatId);
  }

  return true;
}

export function parsePermissionCallbackData(rawData: string): PermissionCallbackData | null {
  const data = unwrapCallbackAction(rawData);
  if (!data.startsWith('perm:')) return null;

  const [, decision, ...requestIdParts] = data.split(':');
  const requestId = requestIdParts.join(':');
  if (!isPermissionDecision(decision) || !requestId) return null;

  return { decision, requestId };
}

export function handlePermissionCallback(
  callback: CallbackQuery,
  agentManager: PermissionAgentManager,
  botConfig: BotConfig,
): boolean {
  const parsed = parsePermissionCallbackData(callback.data);
  if (!parsed) return false;
  if (!isCallbackAuthorized(callback, botConfig)) return false;

  if (parsed.decision === 'deny') {
    return agentManager.denyPermission(parsed.requestId);
  }

  return agentManager.approvePermission(parsed.requestId);
}

export function parseSessionResumeCallback(rawData: string): SessionResumeCallbackData | null {
  const compact = parseCompactResume(rawData);
  if (compact) return compact;

  const direct = parseResumeObject(rawData);
  if (direct) return direct;

  const unwrapped = unwrapCallbackAction(rawData);
  if (unwrapped === rawData) return null;
  return parseResumeObject(unwrapped);
}

function unwrapCallbackAction(rawData: string): string {
  try {
    const parsed = JSON.parse(rawData) as unknown;
    if (
      parsed
      && typeof parsed === 'object'
      && typeof (parsed as { action?: unknown }).action === 'string'
    ) {
      return (parsed as { action: string }).action;
    }
  } catch {
    // Telegram callback_data is a raw string; Feishu button values are JSON envelopes.
  }

  return rawData;
}

/**
 * Parse compact Telegram resume format: "resume:<sessionId>"
 * Used because Telegram callback_data has a 64-byte limit.
 * The cwd is not included; the resume handler looks it up from the session store.
 */
function parseCompactResume(rawData: string): SessionResumeCallbackData | null {
  const unwrapped = unwrapCallbackAction(rawData);
  if (!unwrapped.startsWith('resume:')) return null;
  const sessionId = unwrapped.slice('resume:'.length);
  if (!sessionId) return null;
  return { action: 'resume_cli', sessionId, cwd: '' };
}

function parseResumeObject(rawData: string): SessionResumeCallbackData | null {
  try {
    const parsed = JSON.parse(rawData) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    if (
      record.action !== 'resume_cli'
      || typeof record.sessionId !== 'string'
      || !record.sessionId
    ) {
      return null;
    }
    return { action: 'resume_cli', sessionId: record.sessionId, cwd: typeof record.cwd === 'string' ? record.cwd : '' };
  } catch {
    return null;
  }
}

function isPermissionDecision(value: string | undefined): value is PermissionDecision {
  return value === 'allow' || value === 'allow_session' || value === 'deny';
}

function isGroupCallback(callback: CallbackQuery): boolean {
  return callback.chatType === 'group'
    || callback.chatType === 'supergroup'
    || callback.chatType === 'channel';
}
