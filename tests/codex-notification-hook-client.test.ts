import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runHookClient } from '../src/notifications/hook-client.js';

describe('runHookClient', () => {
  const directories: string[] = [];
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
      server.close(() => resolve());
    })));
    await Promise.all(directories.splice(0).map((directory) => (
      rm(directory, { recursive: true, force: true })
    )));
  });

  it('sends only the normalized approval and strips raw tool arguments', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cli2im-hook-client-'));
    directories.push(directory);
    const socketPath = join(directory, 'hook.sock');
    const received = new Promise<string>((resolve) => {
      const server = createServer((socket) => {
        const chunks: Buffer[] = [];
        socket.on('data', (chunk: Buffer) => chunks.push(chunk));
        socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });
      servers.push(server);
      server.listen(socketPath);
    });
    await new Promise<void>((resolve) => servers[0].once('listening', resolve));

    const input = {
      hook_event_name: 'PermissionRequest',
      session_id: 'session_synthetic',
      turn_id: 'turn_synthetic',
      approval_id: 'approval_synthetic',
      tool_input: { command: 'print synthetic-secret' },
      command: 'print synthetic-secret',
      arguments: ['--token', 'synthetic-token'],
    };
    await runHookClient(Readable.from([JSON.stringify(input)]), socketPath);
    const serialized = await received;

    expect(serialized.endsWith('\n')).toBe(true);
    expect(JSON.parse(serialized)).toEqual({
      type: 'approval',
      sessionId: 'session_synthetic',
      turnId: 'turn_synthetic',
      requestId: 'approval_synthetic',
      occurredAt: expect.any(Number),
    });
    expect(serialized).not.toContain('command');
    expect(serialized).not.toContain('synthetic-secret');
    expect(serialized).not.toContain('arguments');
    expect(serialized).not.toContain('synthetic-token');
  });

  it('resolves silently for invalid input and a missing socket', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cli2im-hook-client-'));
    directories.push(directory);
    const missingSocketPath = join(directory, 'missing.sock');

    await expect(runHookClient(Readable.from(['not-json']), missingSocketPath)).resolves.toBeUndefined();
    await expect(runHookClient(Readable.from([JSON.stringify({
      hook_event_name: 'PermissionRequest',
      session_id: 'session_synthetic',
      turn_id: 'turn_synthetic',
    })]), missingSocketPath)).resolves.toBeUndefined();
  });
});
