import { createHash, randomBytes } from 'node:crypto';
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import type { StructuredLifecycleEvent } from './lifecycle-protocol.js';
import { parseStructuredLifecycleEvent } from './lifecycle-protocol.js';

const STATE_DIR = 'codex-task-state';
const OUTBOX_DIR = 'codex-notification-outbox';
const ORPHAN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type HookTaskStateName =
  | 'RUNNING'
  | 'WAITING_APPROVAL'
  | 'WAITING_QUESTION'
  | 'COMPLETED'
  | 'ENDED_UNREPORTED'
  | 'CANCELLED';

export interface HookTaskState {
  version: 1;
  taskId: string;
  sessionId: string;
  firstTurnId: string;
  currentTurnId: string;
  projectName: string;
  taskName: string;
  state: HookTaskStateName;
  reportedTurnId?: string;
  protocolContinuationPending?: { token: string; taskId: string };
  updatedAt: number;
}

export async function loadHookTaskState(
  root: string,
  sessionId: string,
): Promise<HookTaskState | null> {
  try {
    const parsed = JSON.parse(await readFile(statePath(root, sessionId), 'utf8')) as unknown;
    return isHookTaskState(parsed) ? parsed : null;
  } catch (error) {
    return isMissing(error) ? null : null;
  }
}

export async function registerUserPrompt(
  root: string,
  event: Extract<StructuredLifecycleEvent, { type: 'user_prompt' }>,
  protocolContinuation: boolean,
): Promise<HookTaskState> {
  const existing = await loadHookTaskState(root, event.sessionId);
  const resumes = existing && (
    protocolContinuation
    || existing.state === 'WAITING_QUESTION'
    || existing.state === 'WAITING_APPROVAL'
  );
  const state: HookTaskState = resumes ? {
    ...existing,
    currentTurnId: event.turnId,
    state: 'RUNNING',
    reportedTurnId: undefined,
    protocolContinuationPending: undefined,
    updatedAt: event.occurredAt,
  } : {
    version: 1,
    taskId: digest(`${event.sessionId}\u001f${event.turnId}`),
    sessionId: event.sessionId,
    firstTurnId: event.turnId,
    currentTurnId: event.turnId,
    projectName: event.projectName,
    taskName: event.taskName,
    state: 'RUNNING',
    updatedAt: event.occurredAt,
  };
  await saveHookTaskState(root, state);
  return state;
}

export async function recordTurnStatus(
  root: string,
  state: HookTaskState,
  input: {
    status: 'waiting' | 'completed';
    reason?: 'question' | 'confirmation';
    turnId: string;
    eventKey: string;
    occurredAt: number;
  },
): Promise<HookTaskState> {
  const next: HookTaskState = {
    ...state,
    currentTurnId: input.turnId,
    state: input.status === 'completed'
      ? 'COMPLETED'
      : input.reason === 'confirmation'
        ? 'WAITING_APPROVAL'
        : 'WAITING_QUESTION',
    reportedTurnId: input.turnId,
    protocolContinuationPending: undefined,
    updatedAt: input.occurredAt,
  };
  await saveHookTaskState(root, next);
  return next;
}

export async function recordApprovalRequested(
  root: string,
  state: HookTaskState,
  occurredAt: number,
): Promise<HookTaskState> {
  const next: HookTaskState = { ...state, state: 'WAITING_APPROVAL', updatedAt: occurredAt };
  await saveHookTaskState(root, next);
  return next;
}

export async function markEndedUnreported(
  root: string,
  state: HookTaskState,
  occurredAt: number,
): Promise<HookTaskState> {
  const next: HookTaskState = {
    ...state,
    state: 'ENDED_UNREPORTED',
    protocolContinuationPending: undefined,
    updatedAt: occurredAt,
  };
  await saveHookTaskState(root, next);
  return next;
}

export async function markProtocolContinuation(
  root: string,
  state: HookTaskState,
): Promise<string> {
  const token = randomBytes(16).toString('hex');
  await saveHookTaskState(root, {
    ...state,
    protocolContinuationPending: { token, taskId: state.taskId },
    updatedAt: Date.now(),
  });
  return token;
}

export async function consumeProtocolContinuation(
  root: string,
  sessionId: string,
  token: string,
): Promise<boolean> {
  const state = await loadHookTaskState(root, sessionId);
  if (!state || state.protocolContinuationPending?.token !== token) return false;
  await saveHookTaskState(root, {
    ...state,
    protocolContinuationPending: undefined,
    updatedAt: Date.now(),
  });
  return true;
}

export async function saveHookTaskState(root: string, state: HookTaskState): Promise<void> {
  const directory = join(root, STATE_DIR);
  await ensurePrivateDirectory(directory);
  await atomicPrivateWrite(statePath(root, state.sessionId), JSON.stringify(state));
}

export interface OutboxItem {
  path: string;
  event: StructuredLifecycleEvent;
}

export async function writeOutboxEvent(
  root: string,
  event: StructuredLifecycleEvent,
): Promise<string> {
  const directory = join(root, OUTBOX_DIR);
  await ensurePrivateDirectory(directory);
  const path = join(directory, `${String(event.occurredAt).padStart(16, '0')}-${event.eventKey}.json`);
  try {
    await atomicPrivateWrite(path, JSON.stringify(event), true);
  } catch (error) {
    if (!isExists(error)) throw error;
  }
  return path;
}

export async function listOutboxEvents(
  root: string,
  now = Date.now(),
): Promise<OutboxItem[]> {
  const directory = join(root, OUTBOX_DIR);
  await ensurePrivateDirectory(directory);
  const entries = await readdir(directory);
  const result: OutboxItem[] = [];
  for (const name of entries.sort()) {
    if (!name.endsWith('.json')) continue;
    const path = join(directory, name);
    try {
      const info = await stat(path);
      if (now - info.mtimeMs > ORPHAN_MAX_AGE_MS) {
        await unlink(path);
        continue;
      }
      const event = parseStructuredLifecycleEvent(JSON.parse(await readFile(path, 'utf8')) as unknown);
      if (event) result.push({ path, event });
    } catch {
      // A concurrent drain or malformed private marker is safely ignored.
    }
  }
  return result.sort((a, b) => (
    a.event.occurredAt - b.event.occurredAt || a.event.eventKey.localeCompare(b.event.eventKey)
  ));
}

export async function removeOutboxEvent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function atomicPrivateWrite(path: string, contents: string, exclusive = false): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (exclusive) {
      try {
        await stat(path);
        const error = new Error('exists') as NodeJS.ErrnoException;
        error.code = 'EEXIST';
        throw error;
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    try { await unlink(temporary); } catch { /* best effort */ }
    throw error;
  }
}

function statePath(root: string, sessionId: string): string {
  return join(root, STATE_DIR, `${digest(sessionId)}.json`);
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isHookTaskState(value: unknown): value is HookTaskState {
  if (!isRecord(value)) return false;
  return value.version === 1
    && nonEmpty(value.taskId)
    && nonEmpty(value.sessionId)
    && nonEmpty(value.firstTurnId)
    && nonEmpty(value.currentTurnId)
    && nonEmpty(value.projectName)
    && nonEmpty(value.taskName)
    && ['RUNNING', 'WAITING_APPROVAL', 'WAITING_QUESTION', 'COMPLETED', 'ENDED_UNREPORTED', 'CANCELLED'].includes(String(value.state))
    && Number.isFinite(value.updatedAt);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function isExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'EEXIST';
}
