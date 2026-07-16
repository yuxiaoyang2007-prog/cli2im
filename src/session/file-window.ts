import { open, readFile, stat } from 'node:fs/promises';

const HEAD_BYTES = 4096;
const TAIL_BYTES = 32768;
const MAX_WINDOW_BYTES = 65536;
const MAX_FULL_TEXT_BYTES = 65536;
const CAPPED_HEAD_BYTES = 32768;
const ROLLOUT_CONTEXT_HEAD_BYTES = 256 * 1024;
const ROLLOUT_CONTEXT_TAIL_BYTES = 1024 * 1024;

export async function readHeadTailWindow(filePath: string): Promise<string> {
  let fh;
  try {
    fh = await open(filePath, 'r');
    const fileStat = await fh.stat();
    const headBytes = Math.min(HEAD_BYTES, MAX_WINDOW_BYTES, fileStat.size);
    const tailBytes = Math.min(TAIL_BYTES, MAX_WINDOW_BYTES - headBytes, fileStat.size);

    const head = await readAt(fh, headBytes, 0);
    const tailStart = Math.max(0, fileStat.size - tailBytes);
    const tail = tailStart <= headBytes ? '' : await readAt(fh, tailBytes, tailStart);

    return tail ? `${head}\n${tail}` : head;
  } catch {
    return '';
  } finally {
    await fh?.close();
  }
}

export async function readRolloutContextWindow(filePath: string): Promise<string> {
  let fh;
  try {
    fh = await open(filePath, 'r');
    const fileStat = await fh.stat();
    const headBytes = Math.min(ROLLOUT_CONTEXT_HEAD_BYTES, fileStat.size);
    const head = await readAt(fh, headBytes, 0);
    if (headBytes === fileStat.size) return head;

    const tailBytes = Math.min(ROLLOUT_CONTEXT_TAIL_BYTES, fileStat.size - headBytes);
    const tailStart = fileStat.size - tailBytes;
    const tail = await readAt(fh, tailBytes, tailStart);
    return tail ? `${head}\n${tail}` : head;
  } catch {
    return '';
  } finally {
    await fh?.close();
  }
}

export async function readCappedTextFile(filePath: string): Promise<string> {
  try {
    const fileStat = await stat(filePath);
    if (fileStat.size <= MAX_FULL_TEXT_BYTES) {
      return await readFile(filePath, 'utf8');
    }
    return await readHead(filePath, CAPPED_HEAD_BYTES);
  } catch {
    return '';
  }
}

async function readAt(
  fh: Awaited<ReturnType<typeof open>>,
  bytes: number,
  position: number,
): Promise<string> {
  if (bytes <= 0) return '';
  const buf = Buffer.alloc(bytes);
  const { bytesRead } = await fh.read(buf, 0, bytes, position);
  return buf.subarray(0, bytesRead).toString('utf8');
}

async function readHead(filePath: string, bytes: number): Promise<string> {
  let fh;
  try {
    fh = await open(filePath, 'r');
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh?.close();
  }
}
