import { mkdtempSync } from 'node:fs';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexNotificationSocket } from '../src/notifications/socket-server.js';
import type { PermissionHookEvent } from '../src/notifications/codex-events.js';

const approvalInput = {
  hook_event_name: 'PermissionRequest',
  session_id: 'session_synthetic',
  turn_id: 'turn_synthetic',
  approval_id: 'approval_synthetic',
  tool_input: { command: 'synthetic private command' },
  command: 'synthetic private command',
};

const approvalEvent: PermissionHookEvent = {
  type: 'approval',
  sessionId: 'session_synthetic',
  turnId: 'turn_synthetic',
  requestId: 'approval_synthetic',
  occurredAt: 1234,
};

describe('CodexNotificationSocket', () => {
  const directories: string[] = [];
  const sockets: CodexNotificationSocket[] = [];

  afterEach(async () => {
    await Promise.all(sockets.splice(0).map((socket) => socket.stop()));
    await Promise.all(directories.splice(0).map((directory) => (
      rm(directory, { recursive: true, force: true })
    )));
  });

  function setup() {
    const directory = mkdtempSync(join(tmpdir(), 'cli2im-notify-socket-'));
    directories.push(directory);
    const socketPath = join(directory, 'notify.sock');
    const onApproval = vi.fn<(event: PermissionHookEvent) => void>();
    const socket = new CodexNotificationSocket({ socketPath, onApproval });
    sockets.push(socket);
    return { onApproval, socket, socketPath };
  }

  it('creates a current-user-only Unix socket', async () => {
    const { socket, socketPath } = setup();
    await socket.start();

    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
  });

  it('does not unlink a path that this instance never owned', async () => {
    const { socket, socketPath } = setup();
    await writeFile(socketPath, 'synthetic persistent file');

    await socket.stop();

    expect(await readFile(socketPath, 'utf8')).toBe('synthetic persistent file');
  });

  it('accepts an 8192-byte payload and rejects an 8193-byte payload', async () => {
    const { onApproval, socket, socketPath } = setup();
    await socket.start();

    await send(socketPath, sizedApprovalLine(8192));
    expect(onApproval).toHaveBeenCalledTimes(1);

    await send(socketPath, sizedApprovalLine(8193));
    expect(onApproval).toHaveBeenCalledTimes(1);
  });

  it('isolates malformed JSON and forwards one sanitized approval', async () => {
    const { onApproval, socket, socketPath } = setup();
    await socket.start();

    await send(socketPath, Buffer.from('{malformed}\n'));
    await send(socketPath, Buffer.from(`${JSON.stringify(approvalEvent)}\n`));

    expect(onApproval).toHaveBeenCalledTimes(1);
    expect(onApproval).toHaveBeenCalledWith(approvalEvent);
    expect(JSON.stringify(onApproval.mock.calls)).not.toContain('synthetic private command');
  });

  it('rejects raw hook objects and canonical objects with extra fields', async () => {
    const { onApproval, socket, socketPath } = setup();
    await socket.start();

    await send(socketPath, Buffer.from(`${JSON.stringify(approvalInput)}\n`));
    await send(socketPath, Buffer.from(`${JSON.stringify({
      ...approvalEvent,
      command: 'synthetic private command',
    })}\n`));

    expect(onApproval).not.toHaveBeenCalled();
  });

  it('dispatches one complete line before the client closes its write side', async () => {
    const { onApproval, socket, socketPath } = setup();
    await socket.start();
    const client = createConnection(socketPath);
    await new Promise<void>((resolve, reject) => {
      client.once('connect', resolve);
      client.once('error', reject);
    });

    let observed = false;
    try {
      client.write(`${JSON.stringify(approvalEvent)}\n`);
      observed = await waitFor(() => onApproval.mock.calls.length === 1, 250);
    } finally {
      client.destroy();
    }

    expect(observed).toBe(true);
    expect(onApproval).toHaveBeenCalledTimes(1);
  });

  it('uses first-frame-wins semantics for co-delivered frames', async () => {
    const { onApproval, socket, socketPath } = setup();
    await socket.start();
    const secondApproval = { ...approvalEvent, requestId: 'approval_second' };

    await send(socketPath, Buffer.from(
      `${JSON.stringify(approvalEvent)}\n${JSON.stringify(secondApproval)}\n`,
    ));

    expect(onApproval).toHaveBeenCalledTimes(1);
    expect(onApproval).toHaveBeenCalledWith(approvalEvent);
  });

  it('ignores a delayed second frame after dispatching the first', async () => {
    const { onApproval, socket, socketPath } = setup();
    await socket.start();
    const client = createConnection(socketPath);
    client.on('error', () => undefined);
    await new Promise<void>((resolve) => client.once('connect', resolve));

    client.write(`${JSON.stringify(approvalEvent)}\n`);
    expect(await waitFor(() => onApproval.mock.calls.length === 1, 250)).toBe(true);
    client.write(`${JSON.stringify({ ...approvalEvent, requestId: 'approval_delayed' })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    client.destroy();

    expect(onApproval).toHaveBeenCalledTimes(1);
    expect(onApproval).toHaveBeenCalledWith(approvalEvent);
  });

  it('does not recover from a malformed first frame using a later valid frame', async () => {
    const { onApproval, socket, socketPath } = setup();
    await socket.start();

    await send(socketPath, Buffer.from(`{malformed}\n${JSON.stringify(approvalEvent)}\n`));

    expect(onApproval).not.toHaveBeenCalled();
  });

  it('destroys idle clients during stop so shutdown is bounded', async () => {
    const { socket, socketPath } = setup();
    await socket.start();
    const client = createConnection(socketPath);
    await new Promise<void>((resolve, reject) => {
      client.once('connect', resolve);
      client.once('error', reject);
    });

    const stopping = socket.stop();
    const outcome = await Promise.race([
      stopping.then(() => 'stopped' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 150)),
    ]);
    client.destroy();
    await stopping;

    expect(outcome).toBe('stopped');
  });

  it('serializes concurrent starts onto one listening server', async () => {
    const { socket, socketPath } = setup();

    await expect(Promise.all([socket.start(), socket.start()])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
  });

  it('honors stop requested while start is still in progress', async () => {
    const { socket, socketPath } = setup();

    await Promise.all([socket.start(), socket.stop()]);

    expect(await canConnect(socketPath)).toBe(false);
  });
});

function sizedApprovalLine(byteLength: number): Buffer {
  const base: PermissionHookEvent = { ...approvalEvent, requestId: '' };
  const baseBytes = Buffer.byteLength(`${JSON.stringify(base)}\n`);
  if (baseBytes > byteLength) throw new Error('Test payload base is too large');
  base.requestId = 'x'.repeat(byteLength - baseBytes);
  const line = Buffer.from(`${JSON.stringify(base)}\n`);
  if (line.length !== byteLength) throw new Error('Test payload has the wrong size');
  return line;
}

function send(socketPath: string, payload: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = createConnection(socketPath);
    client.once('error', reject);
    client.once('close', () => resolve());
    client.end(payload);
  });
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return predicate();
}

function canConnect(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const client = createConnection(socketPath);
    const timer = setTimeout(() => finish(false), 100);
    let settled = false;
    const finish = (connected: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.destroy();
      resolve(connected);
    };
    client.once('connect', () => finish(true));
    client.once('error', () => finish(false));
  });
}
