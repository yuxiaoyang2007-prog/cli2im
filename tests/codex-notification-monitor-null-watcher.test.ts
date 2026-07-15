import { mkdtempSync } from 'node:fs';
import { appendFile, mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CodexEventMonitor,
  type CodexMonitorDelivery,
} from '../src/notifications/monitor.js';
import type { ParsedRolloutLine } from '../src/notifications/codex-events.js';
import { SessionStore } from '../src/session/store.js';

const watcherHarness = vi.hoisted(() => ({
  listener: undefined as ((eventType: string, filename: string | Buffer | null) => void) | undefined,
}));

const listingGate = vi.hoisted(() => ({
  target: '',
  armed: false,
  entered: undefined as (() => void) | undefined,
  release: undefined as Promise<void> | undefined,
  releaseNow: undefined as (() => void) | undefined,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    watch: (
      _path: Parameters<typeof actual.watch>[0],
      _options: Parameters<typeof actual.watch>[1],
      listener: (eventType: string, filename: string | Buffer | null) => void,
    ) => {
      watcherHarness.listener = listener;
      return { close: vi.fn() } as unknown as ReturnType<typeof actual.watch>;
    },
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      if (listingGate.armed && String(args[0]) === listingGate.target) {
        listingGate.armed = false;
        listingGate.entered?.();
        await listingGate.release;
      }
      return actual.readdir(...args);
    },
  };
});

describe('CodexEventMonitor null-filename startup fallback', () => {
  const directories: string[] = [];
  const monitors: CodexEventMonitor[] = [];
  const stores: SessionStore[] = [];

  afterEach(async () => {
    listingGate.releaseNow?.();
    listingGate.target = '';
    listingGate.armed = false;
    listingGate.entered = undefined;
    listingGate.release = undefined;
    listingGate.releaseNow = undefined;
    await Promise.all(monitors.splice(0).map((monitor) => monitor.stop()));
    watcherHarness.listener = undefined;
    for (const store of stores.splice(0)) store.close();
    await Promise.all(directories.splice(0).map((directory) => (
      rm(directory, { recursive: true, force: true })
    )));
  });

  it('uses recent mtime for a null watcher event before the first listing', async () => {
    const { file, monitor, onEvent, sessionsDir, store } = await setup();
    await writeHistoricalFile(file);
    const gate = armListingGate(sessionsDir);

    const starting = monitor.start();
    await gate.entered;
    const boundary = startupBoundary(monitor);
    const currentTime = boundary + 1_000;
    await appendFile(file, `${completionLine('null-before-listing', currentTime)}\n`);
    await utimes(file, new Date(currentTime), new Date(currentTime));
    watcherHarness.listener?.('change', null);
    gate.release();
    await starting;

    expect(onEvent.mock.calls).toEqual([
      [
        expect.objectContaining({ type: 'completed', turnId: 'historical' }),
        file,
        { mode: 'startup-catchup', notificationAllowed: false },
      ],
      [
        expect.objectContaining({
          type: 'completed', turnId: 'null-before-listing', occurredAt: currentTime,
          durationMs: 2_500,
        }),
        file,
        { mode: 'startup-catchup', notificationAllowed: true },
      ],
    ]);
    await expectEofWithoutReplay(monitor, store, file, onEvent);
  });

  it('uses recent mtime for a null watcher event after listing but before inspection', async () => {
    const { file, onEvent, sessionsDir, store } = await setup();
    await monitors.pop()?.stop();
    await writeHistoricalFile(file);
    const blocker = join(dirname(file), 'rollout-000-null-blocker.jsonl');
    await writeHistoricalFile(blocker);
    const inspection = barrierCursorStore(store, blocker);
    const monitor = new CodexEventMonitor({
      sessionsDir,
      store: inspection.store,
      onEvent,
    });
    monitors.push(monitor);

    const starting = monitor.start();
    await inspection.entered;
    const boundary = startupBoundary(monitor);
    const currentTime = boundary + 1_000;
    await appendFile(file, `${completionLine('null-before-inspection', currentTime)}\n`);
    await utimes(file, new Date(currentTime), new Date(currentTime));
    watcherHarness.listener?.('change', null);
    inspection.release();
    await starting;

    expect(onEvent.mock.calls).toEqual([
      [
        expect.objectContaining({ type: 'completed', turnId: 'historical' }),
        file,
        { mode: 'startup-catchup', notificationAllowed: false },
      ],
      [
        expect.objectContaining({
          type: 'completed', turnId: 'null-before-inspection', occurredAt: currentTime,
          durationMs: 2_500,
        }),
        file,
        { mode: 'startup-catchup', notificationAllowed: true },
      ],
    ]);
    await expectEofWithoutReplay(monitor, store, file, onEvent);
  });

  it('baselines an old quiescent file without scanning its history', async () => {
    const { file, monitor, onEvent, store } = await setup();
    await writeHistoricalFile(file);
    const chunkCursorWrite = vi.spyOn(store, 'upsertNotificationCursor');

    await monitor.start();

    expect(onEvent).not.toHaveBeenCalled();
    expect(chunkCursorWrite).not.toHaveBeenCalled();
    await expectEofWithoutReplay(monitor, store, file, onEvent);
  });

  async function setup(): Promise<{
    file: string;
    monitor: CodexEventMonitor;
    onEvent: ReturnType<typeof vi.fn<(
      event: ParsedRolloutLine,
      filePath: string,
      delivery?: CodexMonitorDelivery,
    ) => void>>;
    sessionsDir: string;
    store: SessionStore;
  }> {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'cli2im-codex-null-watch-'));
    directories.push(sessionsDir);
    const nestedDir = join(sessionsDir, '2026', '07');
    await mkdir(nestedDir, { recursive: true });
    const file = join(nestedDir, 'rollout-null-watch.jsonl');
    const store = await SessionStore.create(':memory:');
    stores.push(store);
    const onEvent = vi.fn<(
      event: ParsedRolloutLine,
      filePath: string,
      delivery?: CodexMonitorDelivery,
    ) => void>();
    const monitor = new CodexEventMonitor({ sessionsDir, store, onEvent });
    monitors.push(monitor);
    return { file, monitor, onEvent, sessionsDir, store };
  }
});

async function writeHistoricalFile(file: string): Promise<void> {
  const historicalTime = Date.now() - 60_000;
  await writeFile(file, `${completionLine('historical', historicalTime)}\n`);
  await utimes(file, new Date(historicalTime), new Date(historicalTime));
}

function startupBoundary(monitor: CodexEventMonitor): number {
  return (monitor as unknown as { startupBoundary: number }).startupBoundary;
}

function armListingGate(target: string): { entered: Promise<void>; release: () => void } {
  let enteredResolve!: () => void;
  let releaseResolve!: () => void;
  const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
  listingGate.target = target;
  listingGate.armed = true;
  listingGate.entered = enteredResolve;
  listingGate.release = new Promise<void>((resolve) => { releaseResolve = resolve; });
  listingGate.releaseNow = releaseResolve;
  return { entered, release: releaseResolve };
}

function barrierCursorStore(store: SessionStore, target: string): {
  entered: Promise<void>;
  release: () => void;
  store: {
    getNotificationCursor: SessionStore['getNotificationCursor'];
    upsertNotificationCursor: SessionStore['upsertNotificationCursor'];
    upsertNotificationCursors: SessionStore['upsertNotificationCursors'];
  };
} {
  let enteredResolve!: () => void;
  let releaseResolve!: () => void;
  let blocked = false;
  const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
  const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
  return {
    entered,
    release: releaseResolve,
    store: {
      getNotificationCursor: async (filePath: string) => {
        if (filePath === target && !blocked) {
          blocked = true;
          enteredResolve();
          await release;
        }
        return store.getNotificationCursor(filePath);
      },
      upsertNotificationCursor: store.upsertNotificationCursor.bind(store),
      upsertNotificationCursors: store.upsertNotificationCursors.bind(store),
    },
  };
}

async function expectEofWithoutReplay(
  monitor: CodexEventMonitor,
  store: SessionStore,
  file: string,
  onEvent: ReturnType<typeof vi.fn<(
    event: ParsedRolloutLine,
    filePath: string,
    delivery?: CodexMonitorDelivery,
  ) => void>>,
): Promise<void> {
  expect((await store.getNotificationCursor(file))?.byteOffset).toBe((await stat(file)).size);
  const calls = onEvent.mock.calls.length;
  await monitor.processFile(file);
  expect(onEvent).toHaveBeenCalledTimes(calls);
}

function completionLine(turnId: string, occurredAt: number): string {
  return JSON.stringify({
    timestamp: new Date(occurredAt).toISOString(),
    type: 'event_msg',
    payload: {
      type: 'task_complete',
      turn_id: turnId,
      completed_at: occurredAt / 1000,
      duration_ms: 2_500,
    },
  });
}
