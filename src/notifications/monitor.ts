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
type ProcessingOrigin = 'direct' | 'discovery' | 'watcher' | 'settle';

interface TrackedGeneration {
  fileId: string;
  phase: 'active' | 'replacing';
  revision: number;
  lastChangeAt: number;
}

interface DiscoveredFileInspection {
  baseline?: NotificationCursor;
  hasUnreadBytes: boolean;
}

const CONTINUITY_WINDOW_BYTES = 64;
const MAX_IDENTITY_RECHECKS = 4;
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const WATCH_COALESCE_MS = 25;
const REPLACEMENT_QUIET_MS = 250;

export interface CodexEventMonitorOptions {
  sessionsDir: string;
  store: NotificationCursorStore;
  onEvent: (event: ParsedRolloutLine, filePath: string) => void | Promise<void>;
}

export class CodexEventMonitor {
  private readonly sessionsDir: string;
  private readonly store: NotificationCursorStore;
  private readonly onEvent: CodexEventMonitorOptions['onEvent'];
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly watcherTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly replacementTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly generations = new Map<string, TrackedGeneration>();
  private readonly liveWatcherPaths = new Set<string>();
  private readonly startupHistoricalPaths = new Set<string>();
  private watcher: FSWatcher | null = null;
  private state: MonitorState = 'stopped';
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private stopRequested = false;
  private rediscoverRequested = false;
  private discoveryPromise: Promise<void> | null = null;
  private startupListingCaptured = false;

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
      this.liveWatcherPaths.clear();
      this.startupHistoricalPaths.clear();
      this.startupListingCaptured = false;
      watcher = watch(this.sessionsDir, { recursive: true }, (_eventType, filename) => {
        if (this.state === 'stopped' || this.state === 'stopping') return;
        if (this.state === 'starting') {
          if (filename) {
            const filePath = join(this.sessionsDir, filename.toString());
            if (!this.startupHistoricalPaths.has(filePath)) {
              this.liveWatcherPaths.add(filePath);
            }
          }
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
    for (const timer of this.watcherTimers.values()) clearTimeout(timer);
    this.watcherTimers.clear();
    for (const timer of this.replacementTimers.values()) clearTimeout(timer);
    this.replacementTimers.clear();
    this.rediscoverRequested = false;
    if (this.discoveryPromise) {
      try {
        await this.discoveryPromise;
      } catch {
        // Discovery failure is reported to its initiating start/callback.
      }
    }
    await Promise.allSettled([...this.pending.values()]);
    this.state = 'stopped';
  }

  private scheduleWatchedFile(filePath: string): void {
    const replacementTimer = this.replacementTimers.get(filePath);
    if (replacementTimer) {
      clearTimeout(replacementTimer);
      this.replacementTimers.delete(filePath);
    }
    const generation = this.generations.get(filePath);
    if (generation?.phase === 'replacing') {
      if (Date.now() - generation.lastChangeAt >= REPLACEMENT_QUIET_MS) {
        this.setGeneration(filePath, generation.fileId, 'active');
      } else {
        generation.revision += 1;
        generation.lastChangeAt = Date.now();
      }
    }
    const existing = this.watcherTimers.get(filePath);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.watcherTimers.delete(filePath);
      if (this.state !== 'started') return;
      void this.queueFile(filePath, 'watcher')
        .then(() => this.scheduleReplacementSettle(filePath))
        .catch(() => undefined);
    }, WATCH_COALESCE_MS);
    this.watcherTimers.set(filePath, timer);
  }

  async processFile(filePath: string): Promise<void> {
    await this.queueFile(filePath, 'direct');
  }

  private async queueFile(filePath: string, origin: ProcessingOrigin): Promise<void> {
    await this.queuePathOperation(
      filePath,
      () => this.processFileOnce(filePath, origin),
    );
  }

  private async queuePathOperation<T>(
    filePath: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.pending.get(filePath) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(operation);
    this.pending.set(filePath, current);

    try {
      return await current;
    } finally {
      if (this.pending.get(filePath) === current) this.pending.delete(filePath);
    }
  }

  private async discoverFiles(): Promise<void> {
    this.rediscoverRequested = true;
    if (this.discoveryPromise) return this.discoveryPromise;

    const operation = this.runDiscoveryLoop();
    this.discoveryPromise = operation;
    try {
      await operation;
    } finally {
      if (this.discoveryPromise === operation) this.discoveryPromise = null;
    }
  }

  private async runDiscoveryLoop(): Promise<void> {
    while (this.rediscoverRequested && !this.stopRequested) {
      this.rediscoverRequested = false;
      await this.discoverFilesOnce();
    }
  }

  private async discoverFilesOnce(): Promise<void> {
    const files = await discoverRolloutFiles(this.sessionsDir);
    if (this.state === 'starting') {
      if (!this.startupListingCaptured) {
        for (const filePath of files) this.startupHistoricalPaths.add(filePath);
        this.startupListingCaptured = true;
      } else {
        for (const filePath of files) {
          if (!this.startupHistoricalPaths.has(filePath)) this.liveWatcherPaths.add(filePath);
        }
      }
    }
    const baselines: NotificationCursor[] = [];
    const reservations: Array<{
      completion: Promise<void>;
      release: (committed: boolean) => void;
    }> = [];

    try {
      for (const filePath of files) {
        const reservation = this.reserveDiscoveryPath(filePath);
        reservations.push(reservation);
        const inspection = await reservation.ready;
        if (inspection?.baseline) baselines.push(inspection.baseline);
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

      for (const reservation of reservations) {
        reservation.release(true);
        await reservation.completion;
      }
    } catch (error) {
      for (const reservation of reservations) reservation.release(false);
      await Promise.allSettled(reservations.map((reservation) => reservation.completion));
      throw error;
    }
  }

  private reserveDiscoveryPath(filePath: string): {
    ready: Promise<DiscoveredFileInspection | null>;
    completion: Promise<void>;
    release: (committed: boolean) => void;
  } {
    const ready = deferred<DiscoveredFileInspection | null>();
    const commit = deferred<boolean>();
    const completion = this.queuePathOperation(filePath, async () => {
      try {
        const inspection = await this.inspectDiscoveredFile(filePath);
        ready.resolve(inspection);
        const committed = await commit.promise;
        if (
          committed
          && inspection
          && (inspection.baseline || inspection.hasUnreadBytes)
        ) {
          await this.processFileOnce(filePath, 'discovery');
          this.scheduleReplacementSettle(filePath);
        }
        if (committed) this.liveWatcherPaths.delete(filePath);
      } catch (error) {
        ready.reject(error);
        throw error;
      }
    });
    return {
      ready: ready.promise,
      completion,
      release: commit.resolve,
    };
  }

  private async inspectDiscoveredFile(
    filePath: string,
  ): Promise<DiscoveredFileInspection | null> {
    const handle = await openIfPresent(filePath);
    if (!handle) return null;
    try {
      const fileStat = await handle.stat();
      if (!fileStat.isFile()) return null;
      const fileId = `${fileStat.dev}:${fileStat.ino}`;
      const cursor = await this.store.getNotificationCursor(filePath);
      const generation = this.generations.get(filePath);
      const isLiveNew = !cursor
        && !generation
        && (this.state === 'started' || this.liveWatcherPaths.has(filePath));
      const precedingBytes = await readPrecedingBytes(handle, cursor?.byteOffset ?? fileStat.size);
      const hasValidCursor = cursor
        && cursor.fileId === fileId
        && fileStat.size >= cursor.byteOffset
        && typeof cursor.continuityHash === 'string'
        && cursor.continuityHash === hashBytes(precedingBytes);
      if (!hasValidCursor) {
        const byteOffset = isLiveNew ? 0 : fileStat.size;
        const isReplacement = this.state === 'started'
          && !isLiveNew
          && Boolean(cursor || generation);
        this.setGeneration(filePath, fileId, isReplacement ? 'replacing' : 'active');
        return {
          baseline: await makeBaselineCursor(handle, filePath, fileId, byteOffset),
          hasUnreadBytes: isLiveNew && fileStat.size > 0,
        };
      }
      if (generation?.phase === 'replacing') {
        this.setGeneration(filePath, fileId, 'replacing');
        return {
          baseline: await makeBaselineCursor(handle, filePath, fileId, fileStat.size),
          hasUnreadBytes: false,
        };
      }
      this.setGeneration(filePath, fileId, 'active');
      return { hasUnreadBytes: fileStat.size > cursor.byteOffset };
    } finally {
      await handle.close();
    }
  }

  private async processFileOnce(filePath: string, origin: ProcessingOrigin): Promise<void> {
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
        await this.processOpenedFile(filePath, handle, fileId, fileStat.size, origin);
      } finally {
        await handle.close();
      }

      handle = await openIfPresent(filePath);
      if (!handle) return;
      const currentStat = await handle.stat();
      const currentFileId = `${currentStat.dev}:${currentStat.ino}`;
      if (currentFileId === fileId) {
        if (currentStat.size > fileStat.size) continue;
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
    origin: ProcessingOrigin,
  ): Promise<void> {
    let cursor = await this.store.getNotificationCursor(filePath);
    const generation = this.generations.get(filePath);
    const trackReplacement = origin !== 'direct' && this.state === 'started';
    if (!cursor && !generation && trackReplacement) {
      cursor = await makeBaselineCursor(handle, filePath, fileId, 0);
      await this.store.upsertNotificationCursor(cursor);
      this.setGeneration(filePath, fileId, 'active');
    }
    if (!cursor || cursor.fileId !== fileId || fileSize < cursor.byteOffset) {
      await this.baseline(handle, filePath, fileId, fileSize);
      this.setGeneration(
        filePath,
        fileId,
        trackReplacement && Boolean(generation || cursor) ? 'replacing' : 'active',
      );
      return;
    }

    if (generation?.phase === 'replacing' && origin !== 'direct') {
      await this.baseline(handle, filePath, fileId, fileSize);
      this.setGeneration(filePath, fileId, 'replacing');
      return;
    }

    const precedingBytes = await readPrecedingBytes(handle, cursor.byteOffset);
    const continuityHash = hashBytes(precedingBytes);
    if (!cursor.continuityHash) {
      await this.baseline(handle, filePath, fileId, fileSize);
      this.setGeneration(filePath, fileId, trackReplacement ? 'replacing' : 'active');
      return;
    }
    if (cursor.continuityHash !== continuityHash) {
      await this.baseline(handle, filePath, fileId, fileSize);
      this.setGeneration(filePath, fileId, trackReplacement ? 'replacing' : 'active');
      return;
    }
    this.setGeneration(filePath, fileId, generation?.phase ?? 'active');
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

  private setGeneration(
    filePath: string,
    fileId: string,
    phase: TrackedGeneration['phase'],
  ): void {
    const previous = this.generations.get(filePath);
    this.generations.set(filePath, {
      fileId,
      phase,
      revision: phase === 'replacing' && previous?.phase !== 'replacing'
        ? (previous?.revision ?? 0) + 1
        : (previous?.revision ?? 0),
      lastChangeAt: phase === 'replacing'
        ? (previous?.phase === 'replacing' ? previous.lastChangeAt : Date.now())
        : 0,
    });
  }

  private scheduleReplacementSettle(filePath: string): void {
    if (this.state !== 'started') return;
    const generation = this.generations.get(filePath);
    if (generation?.phase !== 'replacing') return;
    const existing = this.replacementTimers.get(filePath);
    if (existing) clearTimeout(existing);
    const revision = generation.revision;
    const timer = setTimeout(() => {
      this.replacementTimers.delete(filePath);
      if (this.state !== 'started') return;
      void this.queueFile(filePath, 'settle').then(() => {
        const current = this.generations.get(filePath);
        if (
          this.state === 'started'
          && current?.phase === 'replacing'
          && current.revision === revision
        ) {
          this.setGeneration(filePath, current.fileId, 'active');
        }
      }).catch(() => undefined);
    }, REPLACEMENT_QUIET_MS);
    this.replacementTimers.set(filePath, timer);
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

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
