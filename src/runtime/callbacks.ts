import type { CallbackQuery } from '../types.js';

type PermissionDecision = 'allow' | 'allow_session' | 'deny';

export interface PermissionCallbackData {
  decision: PermissionDecision;
  requestId: string;
}

export interface PermissionAgentManager {
  approvePermission(requestId: string): boolean;
  denyPermission(requestId: string): boolean;
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
): boolean {
  const parsed = parsePermissionCallbackData(callback.data);
  if (!parsed) return false;

  if (parsed.decision === 'deny') {
    return agentManager.denyPermission(parsed.requestId);
  }

  return agentManager.approvePermission(parsed.requestId);
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

function isPermissionDecision(value: string | undefined): value is PermissionDecision {
  return value === 'allow' || value === 'allow_session' || value === 'deny';
}
