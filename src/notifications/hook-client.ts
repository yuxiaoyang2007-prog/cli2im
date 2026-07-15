import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createConnection, type Socket } from 'node:net';
import { normalizePermissionHook } from './codex-events.js';

const MAX_INPUT_BYTES = 8192;
const CONNECT_TIMEOUT_MS = 500;

export async function runHookClient(
  input: NodeJS.ReadableStream,
  socketPath = join(homedir(), '.cli2im', 'codex-notify.sock'),
): Promise<void> {
  try {
    const bytes = await readInput(input);
    if (!bytes) return;

    const approval = normalizePermissionHook(JSON.parse(bytes.toString('utf8')) as unknown, Date.now());
    if (!approval) return;

    await send(socketPath, `${JSON.stringify(approval)}\n`);
  } catch {
    // Hooks must remain silent and must never affect the caller's exit status.
  }
}

function readInput(input: NodeJS.ReadableStream): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const finish = (result: Buffer | null) => {
      if (settled) return;
      settled = true;
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('error', onError);
      resolve(result);
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

function send(socketPath: string, payload: string): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let socket: Socket | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      resolve();
    };
    const timer = setTimeout(finish, CONNECT_TIMEOUT_MS);

    try {
      socket = createConnection(socketPath);
      socket.once('error', finish);
      socket.once('connect', () => socket?.end(payload, finish));
    } catch {
      finish();
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runHookClient(process.stdin);
}
