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
    await send(socketPath, Buffer.from(`${JSON.stringify(approvalInput)}\n`));

    expect(onApproval).toHaveBeenCalledTimes(1);
    expect(onApproval).toHaveBeenCalledWith({
      type: 'approval',
      sessionId: 'session_synthetic',
      turnId: 'turn_synthetic',
      requestId: 'approval_synthetic',
      occurredAt: expect.any(Number),
    });
    expect(JSON.stringify(onApproval.mock.calls)).not.toContain('synthetic private command');
  });
});

function sizedApprovalLine(byteLength: number): Buffer {
  const base = { ...approvalInput, padding: '' };
  const baseBytes = Buffer.byteLength(`${JSON.stringify(base)}\n`);
  if (baseBytes > byteLength) throw new Error('Test payload base is too large');
  base.padding = 'x'.repeat(byteLength - baseBytes);
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
