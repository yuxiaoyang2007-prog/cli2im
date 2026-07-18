import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

export interface KimiWorkRpcRequest<P = unknown> {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params?: P;
}

export interface KimiWorkRpcResponse<R = unknown> {
  jsonrpc: '2.0';
  id: string;
  result?: R;
  error?: { code: number; message: string; data?: unknown };
}

export interface KimiWorkRpcNotification<P = unknown> {
  jsonrpc: '2.0';
  method: string;
  params?: P;
}

export interface KimiWorkConversationCreateParams {
  sessionKey: string;
}

export interface KimiWorkConversationCreateResult {
  agentId: string;
  session: { activeConversationKey: string; [key: string]: unknown };
  conversation: { [key: string]: unknown };
}

export interface KimiWorkConversationSetActiveParams {
  sessionKey: string;
  conversationKey: string;
}

export interface KimiWorkConversationSetActiveResult {
  [key: string]: unknown;
}

export interface KimiWorkConversationSendParams {
  conversationKey: string;
  text: string;
  modelAlias: string;
  thinkingLevel: 'low' | 'high' | 'max';
}

export interface KimiWorkConversationSendResult {
  accepted: boolean;
  turnId: string;
  conversationKey: string;
  trace?: { traceId?: string; [key: string]: unknown };
}

export interface KimiWorkConversationCancelParams {
  conversationKey: string;
}

export interface KimiWorkConversationCancelResult {
  [key: string]: unknown;
}

export interface KimiWorkConversationGetMessagesParams {
  conversationKey: string;
}

export interface KimiWorkMessagePart {
  kind: 'reasoning' | 'text' | 'tool-call' | 'tool-result' | string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  name?: string;
  input?: unknown;
  output?: unknown;
  result?: unknown;
  isError?: boolean;
  [key: string]: unknown;
}

export interface KimiWorkMessage {
  id: string;
  role: string;
  parts: KimiWorkMessagePart[];
  status: string;
  turnId?: string;
  [key: string]: unknown;
}

export interface KimiWorkConversationGetMessagesResult {
  messages: KimiWorkMessage[];
  [key: string]: unknown;
}

export interface KimiWorkMessageEventParams {
  conversationKey: string;
  turnId: string;
  origin?: string;
  message: KimiWorkMessage;
}

export interface KimiWorkConversationChangedParams {
  conversationKey: string;
  kind: string;
  [key: string]: unknown;
}

export interface KimiWorkConversationContextUpdatedParams {
  conversationKey: string;
  [key: string]: unknown;
}

export interface KimiWorkInteractionTurn {
  agentId?: string;
  sessionKey?: string;
  conversationKey: string;
  kernelSessionId?: string;
  requestId?: string;
  executionSurface?: string;
  turnId?: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  [key: string]: unknown;
}

export interface KimiWorkInteraction {
  id: string;
  kind: 'tool-approval' | string;
  createdAt: string;
  expiresAt: string;
  turn: KimiWorkInteractionTurn;
  toolName?: string;
  input?: unknown;
  [key: string]: unknown;
}

export interface KimiWorkInteractionPendingParams {
  interaction: KimiWorkInteraction;
}

export interface KimiWorkInteractionTerminalParams {
  interactionId?: string;
  interaction?: KimiWorkInteraction;
  [key: string]: unknown;
}

export interface KimiWorkInteractionRespondParams {
  interactionId: string;
  response: { decision: 'approved' | 'rejected'; feedback?: string };
}

export interface KimiWorkWebSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  on(event: 'open', listener: () => void): this;
  on(event: 'message', listener: (data: unknown) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'close', listener: (code: number, reason: Buffer) => void): this;
}

export type KimiWorkWebSocketFactory = (
  url: string,
  options: { headers: { Authorization: string } },
) => KimiWorkWebSocketLike;

export interface KimiWorkRpcHandlers {
  onNotification?(notification: KimiWorkRpcNotification): void;
  onError?(error: Error): void;
  onClose?(code: number, reason: string): void;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

const defaultWebSocketFactory: KimiWorkWebSocketFactory = (url, options) => {
  const WebSocket = require('ws') as new (
    target: string,
    init: { headers: { Authorization: string } },
  ) => KimiWorkWebSocketLike;
  return new WebSocket(url, options);
};

export class KimiWorkRpcClient {
  private socket: KimiWorkWebSocketLike | undefined;
  private connectPromise: Promise<void> | undefined;
  private connectReject: ((error: Error) => void) | undefined;
  private connectSettled = false;
  private nextId = 1;
  private pending = new Map<string, PendingRequest>();
  private disposed = false;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly handlers: KimiWorkRpcHandlers = {},
    private readonly socketFactory: KimiWorkWebSocketFactory = defaultWebSocketFactory,
  ) {}

  connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    if (this.disposed) return Promise.reject(new Error('kimi-work rpc: disposed'));

    this.connectPromise = new Promise<void>((resolve, reject) => {
      // Hoisted so dispose() can settle a still-pending connect (e.g. the daimon
      // exits mid-handshake) instead of leaving the awaiter hung forever.
      this.connectReject = reject;
      const settle = (error?: Error) => {
        if (this.connectSettled) return;
        this.connectSettled = true;
        if (error) reject(error);
        else resolve();
      };
      let opened = false;
      const socket = this.socketFactory(this.url, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      this.socket = socket;

      socket.on('open', () => {
        opened = true;
        settle();
      });
      socket.on('message', (data) => this.dispatch(data));
      socket.on('error', (error) => {
        if (this.disposed) return;
        settle(error);
        this.failAll(error);
        this.handlers.onError?.(error);
      });
      socket.on('close', (code, reason) => {
        if (this.disposed) return;
        const reasonText = reason?.toString('utf8') ?? '';
        const error = new Error(`kimi-work rpc: socket closed (${code}${reasonText ? `: ${reasonText}` : ''})`);
        if (!opened) settle(error);
        this.failAll(error);
        this.handlers.onClose?.(code, reasonText);
      });
    });

    return this.connectPromise;
  }

  sendRequest<R = unknown>(method: string, params?: unknown): Promise<R> {
    const socket = this.socket;
    if (this.disposed || !socket || socket.readyState !== 1) {
      return Promise.reject(new Error(`kimi-work rpc: transport closed before sending ${method}`));
    }

    const id = `client-${this.nextId++}`;
    const request: KimiWorkRpcRequest = { jsonrpc: '2.0', id, method };
    if (params !== undefined) request.params = params;

    return new Promise<R>((resolve, reject) => {
      this.pending.set(id, { resolve: (result) => resolve(result as R), reject });
      try {
        socket.send(JSON.stringify(request));
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  dispose(reason = 'disposed'): void {
    if (this.disposed) return;
    this.disposed = true;
    const error = new Error(`kimi-work rpc: ${reason}`);
    // Settle a still-pending connect() so its awaiter (startShared) never hangs.
    if (!this.connectSettled) {
      this.connectSettled = true;
      this.connectReject?.(error);
    }
    this.failAll(error);
    try {
      this.socket?.close();
    } catch {
      // The socket is already gone.
    }
  }

  private dispatch(data: unknown): void {
    const text = typeof data === 'string'
      ? data
      : Buffer.isBuffer(data)
        ? data.toString('utf8')
        : String(data);
    let message: KimiWorkRpcResponse | KimiWorkRpcNotification;
    try {
      message = JSON.parse(text) as KimiWorkRpcResponse | KimiWorkRpcNotification;
    } catch {
      return;
    }
    if (message.jsonrpc !== '2.0') return;

    if ('id' in message) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      if (message.error) {
        pending.reject(new KimiWorkRpcError(message.error.code, message.error.message, message.error.data));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if ('method' in message) this.handlers.onNotification?.(message);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

export class KimiWorkRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'KimiWorkRpcError';
  }
}

export interface KimiDaimonReady {
  url: string;
  token: string;
}

export function parseKimiDaimonReadyLine(line: string): KimiDaimonReady | undefined {
  const match = /control server ready url=(ws:\/\/[^\s]+)\s+auth=\S+\s+token=(\S+)/.exec(line);
  return match ? { url: match[1], token: match[2] } : undefined;
}

export async function resolveKimiNodePath(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const nodePath = env.DAIMON_BUNDLE_NODE_BIN
    || '/Applications/Kimi.app/Contents/Resources/resources/runtime/node';
  await access(nodePath, constants.X_OK);
  return nodePath;
}

export interface SpawnKimiDaimonOpts {
  binary: string;
  workingDirectory?: string;
  env?: Record<string, string>;
  readyTimeoutMs?: number;
}

export interface SpawnedKimiDaimon extends KimiDaimonReady {
  child: ChildProcess;
  nodePath: string;
  shareDir: string;
  configPath: string;
}

export async function spawnKimiDaimon(opts: SpawnKimiDaimonOpts): Promise<SpawnedKimiDaimon> {
  const env = { ...process.env, ...opts.env };
  const nodePath = await resolveKimiNodePath(env);
  const shareDir = env.KIMI_SHARE_DIR || join(homedir(), '.cli2im', 'kimi-work');
  const configPath = env.DAIMON_CONFIG_PATH || join(shareDir, 'config.json');
  await mkdir(shareDir, { recursive: true });
  await mkdir(dirname(configPath), { recursive: true });

  const child = spawn(opts.binary, ['--node', nodePath, 'start', '--control'], {
    cwd: opts.workingDirectory,
    env: {
      ...env,
      KIMI_SHARE_DIR: shareDir,
      DAIMON_CONFIG_PATH: configPath,
      DAIMON_BUNDLE_NODE_BIN: nodePath,
      DAIMON_OPENCLAW_COMPATIBILITY: 'disabled',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return new Promise<SpawnedKimiDaimon>((resolve, reject) => {
    let buffer = '';
    let settled = false;
    const timeout = setTimeout(() => finish(new Error('kimi-daimon control server ready timeout')), opts.readyTimeoutMs ?? 15_000);

    const finish = (error?: Error, ready?: KimiDaimonReady) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.off('error', onError);
      child.off('exit', onExit);
      child.stdout?.off('data', onData);
      if (error) {
        try {
          child.kill('SIGTERM');
        } catch {
          // It already exited.
        }
        reject(error);
      } else if (ready) {
        child.stdout?.resume();
        resolve({ ...ready, child, nodePath, shareDir, configPath });
      }
    };
    const onError = (error: Error) => finish(error);
    const onExit = (code: number | null) => finish(new Error(`kimi-daimon exited before ready (code ${code})`));
    const onData = (chunk: Buffer | string) => {
      buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const ready = parseKimiDaimonReadyLine(line);
        if (ready) {
          finish(undefined, ready);
          return;
        }
      }
    };

    child.once('error', onError);
    child.once('exit', onExit);
    child.stdout?.on('data', onData);
  });
}
