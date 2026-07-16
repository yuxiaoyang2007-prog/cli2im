import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { sanitizeMetadataBasename, sanitizeTaskTitle } from './metadata.js';

const MAX_HOOK_BYTES = 8192;
const STATUS_TOOLS = new Map([
  ['mcp__codex_task_notifier__mark_waiting', 'waiting' as const],
  ['mcp__codex_task_notifier__mark_completed', 'completed' as const],
]);

export type StructuredLifecycleEvent =
  | { version: 1; type: 'user_prompt'; eventKey: string; sessionId: string; turnId: string; projectName: string; taskName: string; occurredAt: number }
  | { version: 1; type: 'approval_requested'; eventKey: string; sessionId: string; turnId: string; requestId: string; occurredAt: number }
  | { version: 1; type: 'status_tool'; eventKey: string; sessionId: string; turnId: string; toolUseId: string; status: 'waiting' | 'completed'; reason?: 'question' | 'confirmation'; occurredAt: number }
  | { version: 1; type: 'stop'; eventKey: string; sessionId: string; turnId: string; stopHookActive: boolean; occurredAt: number }
  | { version: 1; type: 'subagent_start' | 'subagent_stop'; eventKey: string; sessionId: string; turnId: string; agentId: string; occurredAt: number };

export function structuredEventKey(parts: string[]): string {
  return createHash('sha256').update(parts.join('\u001f')).digest('hex').slice(0, 32);
}

export function safeProjectName(cwd: string): string {
  const name = sanitizeMetadataBasename(basename(cwd.replaceAll('\\', '/')));
  return name || '未命名项目';
}

export function safeTaskTitle(prompt: string): string {
  const withoutNamedSecrets = prompt.replace(
    /\b(?:token|password|passwd|secret|api[_-]?key|credential)\s*[:=]\s*[^\s]+/giu,
    ' ',
  );
  return sanitizeTaskTitle(withoutNamedSecrets) || '未命名任务';
}

export function normalizeLifecycleHookInput(
  input: unknown,
  now: number,
): StructuredLifecycleEvent | null {
  if (!isRecord(input) || !Number.isFinite(now)) return null;
  try {
    if (Buffer.byteLength(JSON.stringify(input)) > MAX_HOOK_BYTES) return null;
  } catch {
    return null;
  }
  const sessionId = nonEmpty(input.session_id);
  const turnId = nonEmpty(input.turn_id);
  if (!sessionId || !turnId) return null;

  switch (input.hook_event_name) {
    case 'UserPromptSubmit': {
      const cwd = nonEmpty(input.cwd);
      const prompt = typeof input.prompt === 'string' ? input.prompt : '';
      if (!cwd) return null;
      return base('user_prompt', sessionId, turnId, now, {
        projectName: safeProjectName(cwd),
        taskName: safeTaskTitle(prompt),
      });
    }
    case 'PermissionRequest': {
      const requestId = nonEmpty(input.approval_id)
        ?? nonEmpty(input.request_id)
        ?? nonEmpty(input.tool_use_id)
        ?? structuredEventKey(['approval', sessionId, turnId, String(Math.floor(now / 10_000))]);
      return base('approval_requested', sessionId, turnId, now, { requestId });
    }
    case 'PostToolUse': {
      const toolName = nonEmpty(input.tool_name);
      const status = toolName ? STATUS_TOOLS.get(toolName) : undefined;
      const toolUseId = nonEmpty(input.tool_use_id);
      if (!status || !toolUseId) return null;
      const reason = status === 'waiting' && isRecord(input.tool_input)
        && (input.tool_input.reason === 'question' || input.tool_input.reason === 'confirmation')
        ? input.tool_input.reason
        : undefined;
      return base('status_tool', sessionId, turnId, now, {
        toolUseId,
        status,
        ...(reason ? { reason } : {}),
      });
    }
    case 'Stop':
      return base('stop', sessionId, turnId, now, {
        stopHookActive: input.stop_hook_active === true,
      });
    case 'SubagentStart':
    case 'SubagentStop': {
      const agentId = nonEmpty(input.agent_id);
      if (!agentId) return null;
      return base(
        input.hook_event_name === 'SubagentStart' ? 'subagent_start' : 'subagent_stop',
        sessionId,
        turnId,
        now,
        { agentId },
      );
    }
    default:
      return null;
  }
}

export function parseStructuredLifecycleEvent(input: unknown): StructuredLifecycleEvent | null {
  if (!isRecord(input) || input.version !== 1 || !Number.isFinite(input.occurredAt)) return null;
  const event = normalizeCanonical(input);
  if (!event) return null;
  return Object.keys(input).length === Object.keys(event).length ? event : null;
}

function normalizeCanonical(input: Record<string, unknown>): StructuredLifecycleEvent | null {
  const sessionId = nonEmpty(input.sessionId);
  const turnId = nonEmpty(input.turnId);
  const eventKey = nonEmpty(input.eventKey);
  const occurredAt = input.occurredAt as number;
  if (!sessionId || !turnId || !eventKey) return null;
  const common = { version: 1 as const, eventKey, sessionId, turnId, occurredAt };
  switch (input.type) {
    case 'user_prompt': {
      const projectName = nonEmpty(input.projectName);
      const taskName = nonEmpty(input.taskName);
      return projectName && taskName ? { ...common, type: 'user_prompt', projectName, taskName } : null;
    }
    case 'approval_requested': {
      const requestId = nonEmpty(input.requestId);
      return requestId ? { ...common, type: 'approval_requested', requestId } : null;
    }
    case 'status_tool': {
      const toolUseId = nonEmpty(input.toolUseId);
      const status = input.status === 'waiting' || input.status === 'completed' ? input.status : null;
      const reason = input.reason === 'question' || input.reason === 'confirmation' ? input.reason : undefined;
      if (!toolUseId || !status || (status === 'completed' && reason)) return null;
      return { ...common, type: 'status_tool', toolUseId, status, ...(reason ? { reason } : {}) };
    }
    case 'stop':
      return typeof input.stopHookActive === 'boolean'
        ? { ...common, type: 'stop', stopHookActive: input.stopHookActive }
        : null;
    case 'subagent_start':
    case 'subagent_stop': {
      const agentId = nonEmpty(input.agentId);
      return agentId ? { ...common, type: input.type, agentId } : null;
    }
    default:
      return null;
  }
}

function base<T extends StructuredLifecycleEvent['type'], E extends Record<string, unknown>>(
  type: T,
  sessionId: string,
  turnId: string,
  occurredAt: number,
  extra: E,
): Extract<StructuredLifecycleEvent, { type: T }> {
  return {
    version: 1,
    type,
    eventKey: structuredEventKey([type, sessionId, turnId, JSON.stringify(extra)]),
    sessionId,
    turnId,
    occurredAt,
    ...extra,
  } as Extract<StructuredLifecycleEvent, { type: T }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
