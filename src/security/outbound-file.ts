import { constants } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import type { FilePayload } from '../types.js';

export async function openVerifiedOutboundFile(file: FilePayload): Promise<FileHandle> {
  const linkInfo = await lstat(file.path);
  if (!linkInfo.isFile()) {
    throw new Error(`Refusing to send non-regular file: ${file.path}`);
  }

  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const handle = await open(file.path, constants.O_RDONLY | noFollow);
  try {
    const info = await handle.stat();
    assertOutboundFileMatches(file, info);
    return handle;
  } catch (err) {
    await handle.close().catch(() => undefined);
    throw err;
  }
}

export function assertOutboundFileMatches(file: FilePayload, info: Stats): void {
  if (!info.isFile()) {
    throw new Error(`Refusing to send non-regular file: ${file.path}`);
  }
  if (typeof file.size === 'number' && info.size !== file.size) {
    throw new Error(`Refusing to send changed file: ${file.path}`);
  }
  if (typeof file.dev === 'number' && info.dev !== file.dev) {
    throw new Error(`Refusing to send replaced file: ${file.path}`);
  }
  if (typeof file.ino === 'number' && info.ino !== file.ino) {
    throw new Error(`Refusing to send replaced file: ${file.path}`);
  }
  if (typeof file.mtimeMs === 'number' && info.mtimeMs !== file.mtimeMs) {
    throw new Error(`Refusing to send modified file: ${file.path}`);
  }
}
