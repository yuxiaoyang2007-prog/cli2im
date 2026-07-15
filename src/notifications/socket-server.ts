import { lstat, chmod, unlink } from 'node:fs/promises';
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from 'node:net';
import type { PermissionHookEvent } from './codex-events.js';

const MAX_PAYLOAD_BYTES = 8192;
const IDLE_CONNECTION_TIMEOUT_MS = 1000;

type SocketServerState = 'stopped' | 'starting' | 'started' | 'stopping';

export interface CodexNotificationSocketOptions {
  socketPath: string;
  onApproval: (event: PermissionHookEvent) => void | Promise<void>;
}

export class CodexNotificationSocket {
  private readonly socketPath: string;
  private readonly onApproval: CodexNotificationSocketOptions['onApproval'];
  private readonly activeSockets = new Set<Socket>();
  private server: Server | null = null;
  private state: SocketServerState = 'stopped';
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private stopRequested = false;
  private ownsSocketPath = false;

  constructor(options: CodexNotificationSocketOptions) {
    this.socketPath = options.socketPath;
    this.onApproval = options.onApproval;
  }

  async start(): Promise<void> {
    if (this.state === 'started') return;
    if (this.state === 'starting' && this.startPromise) return this.startPromise;
    if (this.state === 'stopping' && this.stopPromise) {
      await this.stopPromise;
      return this.start();
    }

    this.state = 'starting';
    this.stopRequested = false;
    const operation = this.startInternal();
    this.startPromise = operation;
    try {
      await operation;
    } finally {
      if (this.startPromise === operation) this.startPromise = null;
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (this.state === 'stopped' && !this.startPromise) return;

    this.stopRequested = true;
    this.state = 'stopping';
    const operation = this.stopInternal();
    this.stopPromise = operation;
    try {
      await operation;
    } finally {
      if (this.stopPromise === operation) this.stopPromise = null;
    }
  }

  private async startInternal(): Promise<void> {
    let server: Server | null = null;
    let ownsSocketPath = false;
    try {
      await removeStaleSocket(this.socketPath);
      if (this.stopRequested) {
        this.state = 'stopped';
        return;
      }

      server = createServer((socket) => this.handleConnection(socket));
      this.server = server;
      await listen(server, this.socketPath);
      ownsSocketPath = true;
      this.ownsSocketPath = true;
      server.on('error', () => undefined);
      await chmod(this.socketPath, 0o600);

      if (this.stopRequested) {
        this.destroyActiveSockets();
        await closeServerIfListening(server);
        await unlinkIfPresent(this.socketPath);
        this.server = null;
        this.ownsSocketPath = false;
        this.state = 'stopped';
        return;
      }
      this.state = 'started';
    } catch (error) {
      this.destroyActiveSockets();
      if (server) await closeServerIfListening(server);
      if (ownsSocketPath) await unlinkIfPresent(this.socketPath);
      if (this.server === server) this.server = null;
      this.ownsSocketPath = false;
      this.state = 'stopped';
      throw error;
    }
  }

  private async stopInternal(): Promise<void> {
    const starting = this.startPromise;
    if (starting) {
      try {
        await starting;
      } catch {
        // startInternal already cleaned up its server and owned socket path.
      }
    }

    const server = this.server;
    this.server = null;
    this.destroyActiveSockets();
    if (server) await closeServerIfListening(server);
    if (this.ownsSocketPath) await unlinkIfPresent(this.socketPath);
    this.ownsSocketPath = false;
    this.state = 'stopped';
  }

  private handleConnection(socket: Socket): void {
    let payload = Buffer.alloc(0);
    let handled = false;

    this.activeSockets.add(socket);
    socket.setTimeout(IDLE_CONNECTION_TIMEOUT_MS, () => socket.destroy());
    socket.once('close', () => this.activeSockets.delete(socket));
    socket.on('error', () => undefined);
    socket.on('data', (chunk: Buffer) => {
      if (handled) return;
      const remaining = MAX_PAYLOAD_BYTES + 1 - payload.length;
      if (remaining > 0) payload = Buffer.concat([payload, chunk.subarray(0, remaining)]);
      if (payload.length > MAX_PAYLOAD_BYTES || chunk.length > remaining) {
        handled = true;
        socket.destroy();
        return;
      }

      const newline = payload.indexOf(0x0a);
      if (newline === -1) return;

      handled = true;
      socket.destroy();
      void this.handlePayload(payload.subarray(0, newline));
    });
  }

  private async handlePayload(payload: Buffer): Promise<void> {
    if (payload.length === 0 || payload.length >= MAX_PAYLOAD_BYTES) return;

    let input: unknown;
    try {
      input = JSON.parse(payload.toString('utf8')) as unknown;
    } catch {
      return;
    }

    const approval = parsePermissionHookEvent(input);
    if (!approval) return;
    try {
      await this.onApproval(approval);
    } catch {
      // One callback failure must not affect the listening socket.
    }
  }

  private destroyActiveSockets(): void {
    for (const socket of this.activeSockets) socket.destroy();
    this.activeSockets.clear();
  }
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  let pathStat;
  try {
    pathStat = await lstat(socketPath);
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }
  if (!pathStat.isSocket()) return;

  const state = await probeSocket(socketPath);
  if (state === 'active') {
    const error = new Error(`Socket is already active: ${socketPath}`) as NodeJS.ErrnoException;
    error.code = 'EADDRINUSE';
    throw error;
  }
  if (state === 'stale') await unlinkIfPresent(socketPath);
}

function probeSocket(socketPath: string): Promise<'active' | 'stale' | 'unknown'> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const finish = (result: 'active' | 'stale' | 'unknown') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish('unknown'), 100);
    socket.once('connect', () => finish('active'));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      finish(error.code === 'ECONNREFUSED' || error.code === 'ENOENT' ? 'stale' : 'unknown');
    });
  });
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(socketPath, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function closeServerIfListening(server: Server): Promise<void> {
  if (!server.listening) return;
  await closeServer(server);
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function parsePermissionHookEvent(input: unknown): PermissionHookEvent | null {
  if (!isRecord(input)) return null;
  const keys = Object.keys(input);
  const allowedKeys = new Set(['type', 'sessionId', 'turnId', 'requestId', 'occurredAt']);
  if (keys.length !== allowedKeys.size || keys.some((key) => !allowedKeys.has(key))) return null;
  if (
    input.type !== 'approval'
    || !isNonEmptyString(input.sessionId)
    || !isNonEmptyString(input.turnId)
    || !isNonEmptyString(input.requestId)
    || typeof input.occurredAt !== 'number'
    || !Number.isFinite(input.occurredAt)
  ) {
    return null;
  }
  return {
    type: 'approval',
    sessionId: input.sessionId,
    turnId: input.turnId,
    requestId: input.requestId,
    occurredAt: input.occurredAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
