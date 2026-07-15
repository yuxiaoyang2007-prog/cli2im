import { watch, type FSWatcher } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parseRolloutLine, type ParsedRolloutLine } from './codex-events.js';
import type { NotificationCursor } from './types.js';

interface NotificationCursorStore {
  getNotificationCursor(filePath: string): Promise<NotificationCursor | null>;
  upsertNotificationCursor(cursor: NotificationCursor): Promise<void>;
}

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

  constructor(options: CodexEventMonitorOptions) {
    this.sessionsDir = options.sessionsDir;
    this.store = options.store;
    this.onEvent = options.onEvent;
  }

  async start(): Promise<void> {
    if (this.watcher) return;

    this.watcher = watch(this.sessionsDir, { recursive: true }, (_eventType, filename) => {
      if (filename) {
        void this.processFile(join(this.sessionsDir, filename.toString())).catch(() => undefined);
      } else {
        void this.discoverFiles().catch(() => undefined);
      }
    });
    await this.discoverFiles();
  }

  async stop(): Promise<void> {
    this.watcher?.close();
    this.watcher = null;
    await Promise.allSettled([...this.pending.values()]);
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

    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch (error) {
      if (isMissingFile(error)) return;
      throw error;
    }
    if (!fileStat.isFile()) return;

    const fileId = `${fileStat.dev}:${fileStat.ino}`;
    const cursor = await this.store.getNotificationCursor(filePath);
    if (!cursor || cursor.fileId !== fileId || fileStat.size < cursor.byteOffset) {
      await this.store.upsertNotificationCursor({
        filePath,
        fileId,
        byteOffset: fileStat.size,
        updatedAt: Date.now(),
      });
      return;
    }
    if (fileStat.size === cursor.byteOffset) return;

    const handle = await open(filePath, 'r');
    try {
      const unread = Buffer.alloc(fileStat.size - cursor.byteOffset);
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
          updatedAt: Date.now(),
        });
        lineStart = newline + 1;
      }
    } finally {
      await handle.close();
    }
  }
}

function isRolloutPath(filePath: string): boolean {
  const name = basename(filePath);
  return name.startsWith('rollout-') && name.endsWith('.jsonl');
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}
