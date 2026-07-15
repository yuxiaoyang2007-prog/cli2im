import { createHash } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { open, readdir, type FileHandle } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parseRolloutLine, type ParsedRolloutLine } from './codex-events.js';
import type { NotificationCursor } from './types.js';

interface NotificationCursorStore {
  getNotificationCursor(filePath: string): Promise<NotificationCursor | null>;
  upsertNotificationCursor(cursor: NotificationCursor): Promise<void>;
}

type MonitorState = 'stopped' | 'starting' | 'started' | 'stopping';

const CONTINUITY_WINDOW_BYTES = 64;
const MAX_IDENTITY_RECHECKS = 4;

export interface CodexEventMonitorOptions {
  sessionsDir: string;
  store: NotificationCursorStore;
  onEvent: (event: ParsedRolloutLine, filePath: string) => void | Promise<void>;
}

export class CodexEventMonitor {
  private readonly sessionsDir: string;
  private readonly store: NotificationCursorStore;
  private readonly onEvent: CodexEventMonitorOptions['onEvent'];
  private readonly pending = new Map<string, Promise<void>>();
  private watcher: FSWatcher | null = null;
  private state: MonitorState = 'stopped';
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private stopRequested = false;

  constructor(options: CodexEventMonitorOptions) {
    this.sessionsDir = options.sessionsDir;
    this.store = options.store;
    this.onEvent = options.onEvent;
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
    if (this.state === 'stopped' && !this.startPromise) {
      await Promise.allSettled([...this.pending.values()]);
      return;
    }

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
    let watcher: FSWatcher | null = null;
    try {
      watcher = watch(this.sessionsDir, { recursive: true }, (_eventType, filename) => {
        if (this.state === 'stopped' || this.state === 'stopping') return;
        if (filename) {
          void this.processFile(join(this.sessionsDir, filename.toString())).catch(() => undefined);
        } else {
          void this.discoverFiles().catch(() => undefined);
        }
      });
      this.watcher = watcher;
      await this.discoverFiles();
      if (this.stopRequested) {
        watcher.close();
        if (this.watcher === watcher) this.watcher = null;
        this.state = 'stopped';
        return;
      }
      this.state = 'started';
    } catch (error) {
      watcher?.close();
      if (this.watcher === watcher) this.watcher = null;
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
        // startInternal already cleaned up its watcher.
      }
    }
    this.watcher?.close();
    this.watcher = null;
    await Promise.allSettled([...this.pending.values()]);
    this.state = 'stopped';
  }

  async processFile(filePath: string): Promise<void> {
    const previous = this.pending.get(filePath) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => this.processFileOnce(filePath));
    this.pending.set(filePath, current);

    try {
      await current;
    } finally {
      if (this.pending.get(filePath) === current) this.pending.delete(filePath);
    }
  }

  private async discoverFiles(directory = this.sessionsDir): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isMissingFile(error)) return;
      throw error;
    }

    await Promise.all(entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await this.discoverFiles(path);
      } else if (entry.isFile()) {
        await this.processFile(path);
      }
    }));
  }

  private async processFileOnce(filePath: string): Promise<void> {
    if (!isRolloutPath(filePath)) return;

    let handle = await openIfPresent(filePath);
    for (let attempt = 0; handle && attempt < MAX_IDENTITY_RECHECKS; attempt += 1) {
      const fileStat = await handle.stat();
      if (!fileStat.isFile()) {
        await handle.close();
        return;
      }
      const fileId = `${fileStat.dev}:${fileStat.ino}`;
      try {
        await this.processOpenedFile(filePath, handle, fileId, fileStat.size);
      } finally {
        await handle.close();
      }

      handle = await openIfPresent(filePath);
      if (!handle) return;
      const currentStat = await handle.stat();
      const currentFileId = `${currentStat.dev}:${currentStat.ino}`;
      if (currentFileId === fileId) {
        await handle.close();
        return;
      }
    }
    await handle?.close();
  }

  private async processOpenedFile(
    filePath: string,
    handle: FileHandle,
    fileId: string,
    fileSize: number,
  ): Promise<void> {
    const cursor = await this.store.getNotificationCursor(filePath);
    if (!cursor || cursor.fileId !== fileId || fileSize < cursor.byteOffset) {
      await this.baseline(handle, filePath, fileId, fileSize);
      return;
    }

    const precedingBytes = await readPrecedingBytes(handle, cursor.byteOffset);
    const continuityHash = hashBytes(precedingBytes);
    if (!cursor.continuityHash) {
      await this.baseline(handle, filePath, fileId, fileSize);
      return;
    }
    if (cursor.continuityHash !== continuityHash) {
      await this.baseline(handle, filePath, fileId, fileSize);
      return;
    }
    if (fileSize === cursor.byteOffset) {
      return;
    }

    const unread = Buffer.alloc(fileSize - cursor.byteOffset);
    const { bytesRead } = await handle.read(unread, 0, unread.length, cursor.byteOffset);
    const bytes = unread.subarray(0, bytesRead);
    const finalNewline = bytes.lastIndexOf(0x0a);
    if (finalNewline === -1) return;

    let lineStart = 0;
    let byteOffset = cursor.byteOffset;
    while (lineStart <= finalNewline) {
      const newline = bytes.indexOf(0x0a, lineStart);
      if (newline === -1 || newline > finalNewline) break;

      const parsed = parseRolloutLine(bytes.subarray(lineStart, newline).toString('utf8'));
      if (parsed) await this.onEvent(parsed, filePath);

      byteOffset += newline - lineStart + 1;
      await this.store.upsertNotificationCursor({
        filePath,
        fileId,
        byteOffset,
        continuityHash: hashSnapshotPrecedingBytes(
          precedingBytes,
          bytes,
          byteOffset - cursor.byteOffset,
        ),
        updatedAt: Date.now(),
      });
      lineStart = newline + 1;
    }
  }

  private async baseline(
    handle: FileHandle,
    filePath: string,
    fileId: string,
    byteOffset: number,
  ): Promise<void> {
    await this.store.upsertNotificationCursor({
      filePath,
      fileId,
      byteOffset,
      continuityHash: hashBytes(await readPrecedingBytes(handle, byteOffset)),
      updatedAt: Date.now(),
    });
  }
}

function isRolloutPath(filePath: string): boolean {
  const name = basename(filePath);
  return name.startsWith('rollout-') && name.endsWith('.jsonl');
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

async function openIfPresent(filePath: string): Promise<FileHandle | null> {
  try {
    return await open(filePath, 'r');
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

async function readPrecedingBytes(handle: FileHandle, byteOffset: number): Promise<Buffer> {
  const length = Math.min(CONTINUITY_WINDOW_BYTES, byteOffset);
  const bytes = Buffer.alloc(length);
  if (length > 0) {
    const { bytesRead } = await handle.read(bytes, 0, length, byteOffset - length);
    return bytes.subarray(0, bytesRead);
  }
  return bytes;
}

function hashSnapshotPrecedingBytes(
  anchor: Buffer,
  appended: Buffer,
  consumedBytes: number,
): string {
  const appendedLength = Math.min(CONTINUITY_WINDOW_BYTES, consumedBytes);
  const anchorLength = Math.min(
    anchor.length,
    CONTINUITY_WINDOW_BYTES - appendedLength,
  );
  const snapshot = Buffer.concat([
    anchor.subarray(anchor.length - anchorLength),
    appended.subarray(consumedBytes - appendedLength, consumedBytes),
  ]);
  return hashBytes(snapshot);
}

function hashBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 24);
}
