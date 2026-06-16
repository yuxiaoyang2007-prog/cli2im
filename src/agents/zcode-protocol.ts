import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { SpawnOpts } from '../types.js';

// =============================================================================
// zcode app-server JSON-RPC protocol layer.
//
// The zcode CLI exposes a `zcode app-server` subcommand that speaks a
// JSON-RPC-style protocol over stdio. IMPORTANT wire detail (verified by
// live probing): zcode does NOT use the standard `jsonrpc:"2.0"` envelope
// field — messages are bare `{id?, method?, params?, result?, error?}`
// objects. Framing is NDJSON: every message is exactly
// `JSON.stringify(msg) + "\n"`. stderr carries structured logs only.
//
// Dispatch rules (verified against the server's Wbr union schema):
//   - {id, result|error}     → response to one of OUR requests
//   - {id, method, params}   → a request FROM the server (e.g. permission)
//   - {method, params}       → a notification (e.g. session/event)
//
// No `initialize` handshake is required: `session/create` may be the very
// first request. The server pushes live session events as notifications
// with `method:"session/event"`, and asks for permission via server→client
// *requests* with `method:"interaction/requestPermission"` (these carry an
// `id` and expect a normal `{id, result}` response).
//
// Wire schemas were reverse-engineered from the zcode.cjs bundle and
// confirmed by live round-trip probing.
// =============================================================================

// --- message envelopes (NOTE: no `jsonrpc` field on the wire) ----------------

export interface ZcodeRpcRequest<P = unknown> {
  id: string | number;
  method: string;
  params?: P;
}

export interface ZcodeRpcResponse<R = unknown> {
  id: string | number;
  result?: R;
  error?: { code: number; message: string; data?: unknown };
}

export interface ZcodeRpcNotification<P = unknown> {
  method: string;
  params?: P;
}

/** Any message that can arrive on stdout. */
export type ZcodeRpcInbound = ZcodeRpcRequest | ZcodeRpcResponse | ZcodeRpcNotification;

// --- session/create + session/resume ----------------------------------------

export interface ZcodeWorkspaceRef {
  workspacePath: string;
  workspaceKey: string;
  workspaceIdentity?: string;
}

export type ZcodeMode = 'plan' | 'build' | 'edit' | 'yolo' | 'auto';

export interface ZcodeSessionCreateParams {
  workspace: ZcodeWorkspaceRef;
  mode?: ZcodeMode;
  persistence?: 'immediate' | 'deferred';
}

export interface ZcodeSessionResumeParams {
  sessionId: string;
  workspace?: ZcodeWorkspaceRef;
}

export interface ZcodeSessionCreateResult {
  // The session snapshot. NOTE: the session id lives at
  // `result.session.sessionId` (not `.session.id`) — verified live.
  session: { sessionId: string; [k: string]: unknown };
  [k: string]: unknown;
}

export interface ZcodeSessionSubscribeParams {
  sessionId: string;
  deliveryKind: 'desktop-continuous' | 'web-remote-replayable';
  afterSeq?: number;
  includeSnapshot?: boolean;
}

export interface ZcodeSessionSendParams {
  sessionId: string;
  content: string;
  inputId?: string;
  queryId?: string;
}

// --- session/event notification payload --------------------------------------
//
// The envelope on a `session/event` notification. Note field names:
// `eventId` / `seq` (NOT `id`/`sequenceNumber` — those are the *internal*
// emit-envelope names; the wire renames them).

export interface ZcodeEventEnvelope<P = unknown> {
  eventId: string;
  sessionId: string;
  turnId?: string;
  seq: number;
  traceId?: string;
  timestamp: number;
  deliveryKind?: 'desktop-continuous' | 'web-remote-replayable';
  type: string;
  payload?: P;
}

// The 24 wire event `type` values the server can push. We only need to
// dispatch on the handful that carry turn output; the rest are ignored.
export type ZcodeWireEventType =
  | 'session.created'
  | 'session.resumed'
  | 'session.updated'
  | 'session.titleUpdated'
  | 'session.closed'
  | 'turn.started'
  | 'turn.steerQueued'
  | 'turn.steerDrained'
  | 'turn.completed'
  | 'turn.failed'
  | 'message.upserted'
  | 'message.removed'
  | 'part.started'
  | 'part.delta'
  | 'part.upserted'
  | 'part.removed'
  | 'model.streaming'
  | 'tool.updated'
  | 'permission.requested'
  | 'permission.resolved'
  | 'userInput.requested'
  | 'userInput.resolved'
  | 'checkpoint.created'
  | 'rewind.triggered'
  | 'streamRecovery.updated';

// part.delta payload — the incremental streaming text channel.
export interface ZcodePartDeltaPayload {
  messageId: string;
  partId: string;
  field?: 'text' | 'reasoning' | 'input' | 'output';
  delta: string;
}

// tool.updated payload — discriminated by `kind`.
export interface ZcodeToolUpdatedPayload {
  kind: 'scheduled' | 'started' | 'progress' | 'result' | 'error' | 'batch';
  toolCallId: string;
  toolName?: string;
  input?: unknown;
  result?: { content?: string; display?: string; success?: boolean; [k: string]: unknown };
  error?: string;
  [k: string]: unknown;
}

// turn.completed payload.
export interface ZcodeTurnCompletedPayload {
  response: string;
  tokenCount: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    [k: string]: unknown;
  };
  toolCallCount?: number;
  duration?: number;
  resultType?: 'success' | 'cancelled' | 'error_max_turns' | 'error_max_budget' | 'error_during_turn' | string;
  inputId?: string;
}

// turn.failed payload.
export interface ZcodeTurnFailedPayload {
  type: string;
  message: string;
  stack?: string;
  code?: string;
  detail?: string;
  retryable?: boolean;
}

// --- interaction/requestPermission (server→client request) ------------------

export interface ZcodePermissionOption {
  optionId: string;
  kind: string;
  name: string;
  description?: string;
}

export interface ZcodePermissionRequestParams {
  requestId: string; // zcode's own id — used to correlate the response
  sessionId: string;
  turnId?: string;
  toolCallId: string;
  toolName: string;
  reason: string;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  input: unknown;
  options: ZcodePermissionOption[];
}

export interface ZcodePermissionDecision {
  decision: 'allow' | 'deny' | 'escalate' | 'modify';
  reason?: string;
  modifiedInput?: unknown;
}

// --- the client --------------------------------------------------------------

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

export interface ZcodeRpcEventHandlers {
  /** Called for every `session/event` notification. */
  onSessionEvent?(env: ZcodeEventEnvelope): void;
  /** Called for a server→client request (e.g. interaction/requestPermission). */
  onRequest?(req: ZcodeRpcRequest): void;
  /** Called for any other notification (state.updated, etc.). */
  onNotification?(notif: ZcodeRpcNotification): void;
  /** Called when the child process exits / errors fatally. */
  onExit?(code: number | null, err?: Error): void;
}

/**
 * A minimal JSON-RPC 2.0 client over a zcode app-server child process.
 *
 * One instance owns one ChildProcess. It is the caller's responsibility to
 * ensure the child is killed when the client is discarded (the `dispose`
 * helper does this).
 */
export class ZcodeRpcClient {
  private readonly child: ChildProcess;
  private readonly emitter = new EventEmitter();
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private disposed = false;

  constructor(child: ChildProcess, handlers: ZcodeRpcEventHandlers = {}) {
    this.child = child;

    if (handlers.onSessionEvent) {
      this.emitter.on('session-event', handlers.onSessionEvent);
    }
    if (handlers.onRequest) {
      this.emitter.on('request', handlers.onRequest);
    }
    if (handlers.onNotification) {
      this.emitter.on('notification', handlers.onNotification);
    }
    if (handlers.onExit) {
      this.emitter.on('exit', handlers.onExit);
    }

    const stdout = child.stdout;
    if (stdout) {
      stdout.setEncoding('utf8');
      stdout.on('data', (chunk: string) => this.onData(chunk));
    }

    // stderr is log-only; surface it for debugging but do not parse it.
    const stderr = child.stderr;
    if (stderr) {
      stderr.setEncoding('utf8');
      stderr.on('data', (chunk: string) => {
        for (const line of chunk.split('\n')) {
          const trimmed = line.trim();
          if (trimmed) this.emitter.emit('log', trimmed);
        }
      });
    }

    child.on('error', (err) => {
      if (this.disposed) return;
      this.emitter.emit('exit', null, err);
      this.failAll(err);
    });
    child.on('exit', (code) => {
      if (this.disposed) return;
      this.emitter.emit('exit', code);
      this.failAll(new Error(`zcode app-server exited with code ${code}`));
    });
  }

  onLog(listener: (line: string) => void): void {
    this.emitter.on('log', listener);
  }

  /** Send a request and await its `result`. Rejects on protocol error or exit. */
  sendRequest<R = unknown>(method: string, params?: unknown): Promise<R> {
    if (this.disposed || !this.child.stdin || this.child.stdin.destroyed) {
      return Promise.reject(new Error(`zcode rpc: transport closed before sending ${method}`));
    }
    const id = `client-${this.nextId++}`;
    const msg: ZcodeRpcRequest = { id, method };
    if (params !== undefined) msg.params = params;

    return new Promise<R>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (r) => resolve(r as R),
        reject,
      });
      this.write(msg);
    });
  }

  /** Send a notification (no id, no response expected). */
  sendNotification(method: string, params?: unknown): void {
    const msg: ZcodeRpcNotification = { method };
    if (params !== undefined) msg.params = params;
    this.write(msg);
  }

  /** Reply to a server→client request (e.g. permission decision). */
  sendResponse(id: string | number, result: unknown): void {
    const msg: ZcodeRpcResponse = { id, result };
    this.write(msg);
  }

  /** Kill the child and reject all pending requests. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.failAll(new Error('zcode rpc: disposed'));
    try {
      this.child.kill('SIGTERM');
    } catch {
      /* already dead */
    }
  }

  // --- internals ------------------------------------------------------------

  private write(msg: unknown): void {
    const stdin = this.child.stdin;
    if (!stdin || stdin.destroyed) return;
    stdin.write(`${JSON.stringify(msg)}\n`);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg: ZcodeRpcInbound;
      try {
        msg = JSON.parse(trimmed) as ZcodeRpcInbound;
      } catch {
        // Not a JSON line we understand — ignore rather than crash the stream.
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: ZcodeRpcInbound): void {
    // Response to one of our requests: has `id` + (`result` | `error`), no `method`.
    if ('id' in msg && !('method' in msg)) {
      const id = String(msg.id);
      const pending = this.pending.get(id);
      if (!pending) return; // stray response — ignore
      this.pending.delete(id);
      if (msg.error) {
        pending.reject(new ZcodeRpcError(msg.error.code, msg.error.message, msg.error.data));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // A request FROM the server (has `id` AND `method`): e.g. permission.
    if ('id' in msg && 'method' in msg) {
      this.emitter.emit('request', msg);
      return;
    }

    // A notification (has `method`, no `id`).
    if ('method' in msg) {
      const notif = msg as ZcodeRpcNotification;
      if (notif.method === 'session/event' && notif.params) {
        this.emitter.emit('session-event', notif.params as ZcodeEventEnvelope);
      } else {
        this.emitter.emit('notification', notif);
      }
    }
  }

  private failAll(err: Error): void {
    for (const [, pending] of this.pending) {
      pending.reject(err);
    }
    this.pending.clear();
  }
}

export class ZcodeRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'ZcodeRpcError';
  }
}

// --- process spawning --------------------------------------------------------

/**
 * Spawn `zcode app-server` as a child process. The binary is a `.cjs`
 * bundle, so it must be launched via `node`. `process.execPath` is used so
 * the same node that runs cli2im also runs zcode (avoids PATH lookups).
 */
export function spawnZcodeAppServer(binary: string, opts: SpawnOpts): ChildProcess {
  return spawn(process.execPath, [binary, 'app-server'], {
    cwd: opts.workingDirectory,
    env: { ...process.env, ...opts.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}
