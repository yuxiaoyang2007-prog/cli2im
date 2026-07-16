import { createConnection, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  normalizeLifecycleHookInput,
  type StructuredLifecycleEvent,
} from './lifecycle-protocol.js';
import {
  consumeProtocolContinuation,
  loadHookTaskState,
  markEndedUnreported,
  markProtocolContinuation,
  recordApprovalRequested,
  recordTurnStatus,
  registerUserPrompt,
  writeOutboxEvent,
} from './task-state-files.js';

const MAX_INPUT_BYTES = 8192;
const CONNECT_TIMEOUT_MS = 350;
const CONTINUATION_PREFIX = 'CODEX_TASK_PROTOCOL_CONTINUATION:';

const STATUS_CONTEXT = [
  '任务状态协议：主任务在停止前必须且只能调用一次 codex_task_notifier 状态工具。',
  '需要用户回答或确认时调用 mark_waiting；只有任务真正交付完成时调用 mark_completed。',
  '审批请求由 Hook 单独通知，不能代替本轮最终状态。子代理不得调用这两个工具。',
].join(' ');

export interface LifecycleHookOptions {
  dataRoot?: string;
  socketPath?: string;
  now?: () => number;
  sendEvent?: (event: StructuredLifecycleEvent) => Promise<void>;
}

export async function runLifecycleHook(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  options: LifecycleHookOptions = {},
): Promise<void> {
  try {
    const bytes = await readInput(input);
    if (!bytes) return;
    const raw = JSON.parse(bytes.toString('utf8')) as unknown;
    if (!isRecord(raw)) return;

    if (raw.hook_event_name === 'SessionStart') {
      writeOutput(output, {
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: STATUS_CONTEXT },
      });
      return;
    }
    if (raw.hook_event_name === 'SubagentStart') {
      writeOutput(output, {
        hookSpecificOutput: {
          hookEventName: 'SubagentStart',
          additionalContext: '你是子代理，不得调用 codex_task_notifier 的 mark_waiting 或 mark_completed。',
        },
      });
    }

    const now = (options.now ?? Date.now)();
    let event = normalizeLifecycleHookInput(raw, now);
    if (!event) return;
    const dataRoot = options.dataRoot ?? join(homedir(), '.cli2im');
    const socketPath = options.socketPath ?? join(dataRoot, 'codex-notify.sock');
    const sendEvent = options.sendEvent ?? ((value) => sendSocketEvent(socketPath, value));

    if (event.type === 'user_prompt') {
      const token = protocolToken(typeof raw.prompt === 'string' ? raw.prompt : '');
      const existing = token ? await loadHookTaskState(dataRoot, event.sessionId) : null;
      const protocolContinuation = Boolean(
        token && existing && await consumeProtocolContinuation(dataRoot, event.sessionId, token),
      );
      if (protocolContinuation && existing) {
        event = {
          ...event,
          projectName: existing.projectName,
          taskName: existing.taskName,
        };
      }
      await registerUserPrompt(dataRoot, event, protocolContinuation);
      await persistAndSend(dataRoot, event, sendEvent);
      writeOutput(output, {
        hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: STATUS_CONTEXT },
      });
      return;
    }

    const state = await loadHookTaskState(dataRoot, event.sessionId);
    if (event.type === 'status_tool') {
      if (!state || state.currentTurnId !== event.turnId) return;
      await recordTurnStatus(dataRoot, state, {
        status: event.status,
        reason: event.reason,
        turnId: event.turnId,
        eventKey: event.eventKey,
        occurredAt: event.occurredAt,
      });
      await persistAndSend(dataRoot, event, sendEvent);
      return;
    }

    if (event.type === 'approval_requested') {
      if (state) await recordApprovalRequested(dataRoot, state, event.occurredAt);
      await persistAndSend(dataRoot, event, sendEvent);
      return;
    }

    if (event.type === 'stop') {
      if (state?.reportedTurnId === event.turnId) {
        await persistAndSend(dataRoot, event, sendEvent);
        writeOutput(output, { continue: true });
        return;
      }
      if (!event.stopHookActive && state) {
        const token = await markProtocolContinuation(dataRoot, state);
        writeOutput(output, {
          decision: 'block',
          reason: `${CONTINUATION_PREFIX}${token} Call mark_waiting or mark_completed now, then stop.`,
        });
        return;
      }
      if (state) await markEndedUnreported(dataRoot, state, event.occurredAt);
      await persistAndSend(dataRoot, event, sendEvent);
      writeOutput(output, { continue: true });
      return;
    }

    await persistAndSend(dataRoot, event, sendEvent);
  } catch {
    // Lifecycle Hooks must not break Codex or expose private input through stderr.
  }
}

async function persistAndSend(
  dataRoot: string,
  event: StructuredLifecycleEvent,
  sendEvent: (event: StructuredLifecycleEvent) => Promise<void>,
): Promise<void> {
  await writeOutboxEvent(dataRoot, event);
  try {
    await sendEvent(event);
  } catch {
    // The outbox is the durable fallback when cli2im is unavailable.
  }
}

function readInput(input: NodeJS.ReadableStream): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (value: Buffer | null) => {
      if (settled) return;
      settled = true;
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('error', onError);
      resolve(value);
    };
    const onData = (value: string | Buffer) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (total + chunk.length > MAX_INPUT_BYTES) {
        input.pause();
        finish(null);
        return;
      }
      chunks.push(chunk);
      total += chunk.length;
    };
    const onEnd = () => finish(Buffer.concat(chunks, total));
    const onError = () => finish(null);
    input.on('data', onData);
    input.once('end', onEnd);
    input.once('error', onError);
    input.resume();
  });
}

function sendSocketEvent(socketPath: string, event: StructuredLifecycleEvent): Promise<void> {
  return new Promise((resolve, reject) => {
    let socket: Socket | undefined;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => finish(new Error('socket timeout')), CONNECT_TIMEOUT_MS);
    try {
      socket = createConnection(socketPath);
      socket.once('error', finish);
      socket.once('connect', () => socket?.end(`${JSON.stringify(event)}\n`, () => finish()));
    } catch (error) {
      finish(error as Error);
    }
  });
}

function writeOutput(output: NodeJS.WritableStream, value: unknown): void {
  output.write(JSON.stringify(value));
}

function protocolToken(prompt: string): string | null {
  const match = new RegExp(`${CONTINUATION_PREFIX}([a-f0-9]{32})`, 'u').exec(prompt);
  return match?.[1] ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runLifecycleHook(process.stdin, process.stdout);
}
