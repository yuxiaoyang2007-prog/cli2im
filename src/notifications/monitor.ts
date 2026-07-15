import { createHash } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { open, readdir, type FileHandle } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parseRolloutLine, type ParsedRolloutLine } from './codex-events.js';
import type { NotificationCursor } from './types.js';

interface NotificationCursorStore {
  getNotificationCursor(filePath: string): Promise<NotificationCursor | null>;
  upsertNotificationCursor(cursor: NotificationCursor): Promise<void>;
  upsertNotificationCursors?(cursors: NotificationCursor[]): Promise<void>;
}

type MonitorState = 'stopped' | 'starting' | 'started' | 'stopping';

const CONTINUITY_WINDOW_BYTES = 64;
const MAX_IDENTITY_RECHECKS = 4;
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const WATCH_COALESCE_MS = 25;

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
  private readonly watcherTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private watcher: FSWatcher | null = null;
  private state: MonitorState = 'stopped';
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private stopRequested = false;
  private rediscoverRequested = false;

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
        if (this.state === 'starting') {
          this.rediscoverRequested = true;
          return;
        }
        if (filename) {
          this.scheduleWatchedFile(join(this.sessionsDir, filename.toString()));
        } else {
          void this.discoverFiles().catch(() => undefined);
        }
      });
      this.watcher = watcher;
      do {
        this.rediscoverRequested = false;
        await this.discoverFiles();
      } while (this.rediscoverRequested && !this.stopRequested);
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
    for (const timer of this.watcherTimers.values()) clearTimeout(timer);
    this.watcherTimers.clear();
    await Promise.allSettled([...this.pending.values()]);
    this.state = 'stopped';
  }

  private scheduleWatchedFile(filePath: string): void {
    const existing = this.watcherTimers.get(filePath);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.watcherTimers.delete(filePath);
      if (this.state !== 'started') return;
      void this.processFile(filePath).catch(() => undefined);
    }, WATCH_COALESCE_MS);
    this.watcherTimers.set(filePath, timer);
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
    const files = await discoverRolloutFiles(directory);
    const baselines: NotificationCursor[] = [];
    const processAfterBaseline: string[] = [];

    for (const filePath of files) {
      const inspection = await this.inspectDiscoveredFile(filePath);
      if (inspection?.baseline) {
        baselines.push(inspection.baseline);
        processAfterBaseline.push(filePath);
      } else if (inspection?.hasUnreadBytes) {
        processAfterBaseline.push(filePath);
      }
    }

    if (baselines.length > 0) {
      if (this.store.upsertNotificationCursors) {
        await this.store.upsertNotificationCursors(baselines);
      } else {
        for (const cursor of baselines) {
          await this.store.upsertNotificationCursor(cursor);
        }
      }
    }

    for (const filePath of processAfterBaseline) {
      await this.processFile(filePath);
    }
  }

  private async inspectDiscoveredFile(filePath: string): Promise<{
    baseline?: NotificationCursor;
    hasUnreadBytes: boolean;
  } | null> {
    const handle = await openIfPresent(filePath);
    if (!handle) return null;
    try {
      const fileStat = await handle.stat();
      if (!fileStat.isFile()) return null;
      const fileId = `${fileStat.dev}:${fileStat.ino}`;
      const cursor = await this.store.getNotificationCursor(filePath);
      const precedingBytes = await readPrecedingBytes(handle, cursor?.byteOffset ?? fileStat.size);
      const hasValidCursor = cursor
        && cursor.fileId === fileId
        && fileStat.size >= cursor.byteOffset
        && typeof cursor.continuityHash === 'string'
        && cursor.continuityHash === hashBytes(precedingBytes);
      if (!hasValidCursor) {
        return {
          baseline: await makeBaselineCursor(handle, filePath, fileId, fileStat.size),
          hasUnreadBytes: false,
        };
      }
      return { hasUnreadBytes: fileStat.size > cursor.byteOffset };
    } finally {
      await handle.close();
    }
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

    const readBuffer = Buffer.alloc(READ_CHUNK_BYTES);
    let readOffset = cursor.byteOffset;
    let persistedOffset = cursor.byteOffset;
    let committedTail = precedingBytes;
    let pendingTail = precedingBytes;
    let lineParts: Buffer[] = [];
    let lineBytes = 0;
    let oversizedLine = false;

    while (readOffset < fileSize) {
      const requested = Math.min(readBuffer.length, fileSize - readOffset);
      const { bytesRead } = await handle.read(readBuffer, 0, requested, readOffset);
      if (bytesRead === 0) return;
      const chunk = readBuffer.subarray(0, bytesRead);
      const chunkStartOffset = readOffset;
      let segmentStart = 0;

      while (segmentStart < chunk.length) {
        const newline = chunk.indexOf(0x0a, segmentStart);
        const segmentEnd = newline === -1 ? chunk.length : newline + 1;
        const segment = chunk.subarray(segmentStart, segmentEnd);
        pendingTail = appendContinuityTail(pendingTail, segment);

        const contentEnd = newline === -1 ? segmentEnd : newline;
        const content = chunk.subarray(segmentStart, contentEnd);
        if (!oversizedLine && content.length > 0) {
          if (lineBytes + content.length > MAX_LINE_BYTES) {
            oversizedLine = true;
            lineParts = [];
            lineBytes = 0;
          } else {
            lineParts.push(Buffer.from(content));
            lineBytes += content.length;
          }
        }

        if (newline !== -1) {
          if (!oversizedLine) {
            const parsed = parseRolloutLine(Buffer.concat(lineParts, lineBytes).toString('utf8'));
            if (parsed) await this.onEvent(parsed, filePath);
          }
          persistedOffset = chunkStartOffset + segmentEnd;
          committedTail = pendingTail;
          pendingTail = committedTail;
          lineParts = [];
          lineBytes = 0;
          oversizedLine = false;
        }
        segmentStart = segmentEnd;
      }

      readOffset += bytesRead;
      if (persistedOffset > cursor.byteOffset) {
        await this.store.upsertNotificationCursor({
          filePath,
          fileId,
          byteOffset: persistedOffset,
          continuityHash: hashBytes(committedTail),
          updatedAt: Date.now(),
        });
        cursor.byteOffset = persistedOffset;
        cursor.continuityHash = hashBytes(committedTail);

        const liveTail = await readPrecedingBytes(handle, persistedOffset);
        if (hashBytes(liveTail) !== cursor.continuityHash) return;
      }
    }
  }

  private async baseline(
    handle: FileHandle,
    filePath: string,
    fileId: string,
    byteOffset: number,
  ): Promise<void> {
    await this.store.upsertNotificationCursor(
      await makeBaselineCursor(handle, filePath, fileId, byteOffset),
    );
  }
}

async function discoverRolloutFiles(root: string): Promise<string[]> {
  const directories = [root];
  const files: string[] = [];
  while (directories.length > 0) {
    const directory = directories.shift();
    if (!directory) break;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isMissingFile(error)) continue;
      throw error;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) directories.push(path);
      else if (entry.isFile() && isRolloutPath(path)) files.push(path);
    }
  }
  return files;
}

async function makeBaselineCursor(
  handle: FileHandle,
  filePath: string,
  fileId: string,
  byteOffset: number,
): Promise<NotificationCursor> {
  return {
    filePath,
    fileId,
    byteOffset,
    continuityHash: hashBytes(await readPrecedingBytes(handle, byteOffset)),
    updatedAt: Date.now(),
  };
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

function appendContinuityTail(anchor: Buffer, appended: Buffer): Buffer {
  if (appended.length >= CONTINUITY_WINDOW_BYTES) {
    return Buffer.from(appended.subarray(appended.length - CONTINUITY_WINDOW_BYTES));
  }
  const anchorLength = Math.min(anchor.length, CONTINUITY_WINDOW_BYTES - appended.length);
  return Buffer.concat([
    anchor.subarray(anchor.length - anchorLength),
    appended,
  ]);
}

function hashBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 24);
}
