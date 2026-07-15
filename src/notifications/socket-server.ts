import { lstat, chmod, unlink } from 'node:fs/promises';
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from 'node:net';
import { normalizePermissionHook, type PermissionHookEvent } from './codex-events.js';

const MAX_PAYLOAD_BYTES = 8192;

export interface CodexNotificationSocketOptions {
  socketPath: string;
  onApproval: (event: PermissionHookEvent) => void | Promise<void>;
}

export class CodexNotificationSocket {
  private readonly socketPath: string;
  private readonly onApproval: CodexNotificationSocketOptions['onApproval'];
  private server: Server | null = null;

  constructor(options: CodexNotificationSocketOptions) {
    this.socketPath = options.socketPath;
    this.onApproval = options.onApproval;
  }

  async start(): Promise<void> {
    if (this.server) return;
    await removeStaleSocket(this.socketPath);

    const server = createServer((socket) => this.handleConnection(socket));
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once('error', onError);
      server.listen(this.socketPath, () => {
        server.off('error', onError);
        resolve();
      });
    });

    try {
      await chmod(this.socketPath, 0o600);
    } catch (error) {
      await closeServer(server);
      throw error;
    }
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await closeServer(server);
    await unlinkIfPresent(this.socketPath);
  }

  private handleConnection(socket: Socket): void {
    let payload = Buffer.alloc(0);
    let rejected = false;

    socket.on('error', () => undefined);
    socket.on('data', (chunk: Buffer) => {
      if (rejected) return;
      const remaining = MAX_PAYLOAD_BYTES + 1 - payload.length;
      if (remaining > 0) payload = Buffer.concat([payload, chunk.subarray(0, remaining)]);
      if (payload.length > MAX_PAYLOAD_BYTES || chunk.length > remaining) {
        rejected = true;
        socket.destroy();
      }
    });
    socket.on('end', () => {
      if (rejected) return;
      void this.handlePayload(payload).finally(() => socket.end());
    });
  }

  private async handlePayload(payload: Buffer): Promise<void> {
    if (payload.length === 0 || payload.length > MAX_PAYLOAD_BYTES) return;
    const newline = payload.indexOf(0x0a);
    if (newline !== payload.length - 1) return;

    let input: unknown;
    try {
      input = JSON.parse(payload.subarray(0, newline).toString('utf8')) as unknown;
    } catch {
      return;
    }

    const approval = normalizePermissionHook(input, Date.now());
    if (!approval) return;
    try {
      await this.onApproval(approval);
    } catch {
      // One callback failure must not affect the listening socket.
    }
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

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
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
