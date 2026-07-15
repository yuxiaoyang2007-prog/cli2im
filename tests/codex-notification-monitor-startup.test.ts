import { mkdtempSync } from 'node:fs';
import { mkdir, rm, stat, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CodexEventMonitor,
  type CodexMonitorDelivery,
} from '../src/notifications/monitor.js';
import type { ParsedRolloutLine } from '../src/notifications/codex-events.js';
import { SessionStore } from '../src/session/store.js';

const listingGate = vi.hoisted(() => ({
  target: '',
  armed: false,
  entered: undefined as (() => void) | undefined,
  release: undefined as Promise<void> | undefined,
  releaseNow: undefined as (() => void) | undefined,
}));

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

describe('CodexEventMonitor startup classification', () => {
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
    for (const store of stores.splice(0)) store.close();
    await Promise.all(directories.splice(0).map((directory) => (
      rm(directory, { recursive: true, force: true })
    )));
  });

  it('treats a pre-listing watcher event on a snapshotted path as catchup', async () => {
    const { file, monitor, onEvent, sessionsDir, store } = await setup();
    const now = Date.now();
    await writeFile(file, [
      completionLine('old-completion', now - 60_000),
      questionLine('old-question-without-time'),
      '',
    ].join('\n'));
    const gate = armListingGate(sessionsDir);

    const starting = monitor.start();
    await gate.entered;
    await appendFile(file, [
      questionLine('current-question', now + 60_000),
      completionLine('current-completion', now + 60_000),
      '',
    ].join('\n'));
    try {
      await waitForStartupWatcher(monitor, file);
    } finally {
      gate.release();
    }
    await starting;

    expect(onEvent.mock.calls.map(([event]) => event.type)).toEqual([
      'completed',
      'question',
      'question',
      'completed',
    ]);
    expect(onEvent.mock.calls.map(([event]) => (
      'turnId' in event ? event.turnId : undefined
    ))).toEqual([
      'old-completion',
      'turn_old-question-without-time',
      'turn_current-question',
      'current-completion',
    ]);
    expect(onEvent.mock.calls.map(([, , delivery]) => delivery)).toEqual([
      { mode: 'startup-catchup', notificationAllowed: false },
      { mode: 'startup-catchup', notificationAllowed: false },
      { mode: 'startup-catchup', notificationAllowed: true },
      { mode: 'startup-catchup', notificationAllowed: true },
    ]);
    await expectEofWithoutReplay(monitor, store, file, onEvent);
  });

  it('treats an after-listing watcher event before inspection completes as catchup', async () => {
    const { file, onEvent, sessionsDir, store } = await setup();
    await monitors.pop()?.stop();
    const now = Date.now();
    await writeFile(file, `${completionLine('old-completion', now - 60_000)}\n`);
    const blocker = join(dirname(file), 'rollout-000-inspection-blocker.jsonl');
    await writeFile(blocker, `${completionLine('blocker', now - 60_000)}\n`);
    const inspection = barrierCursorStore(store, blocker);
    const monitor = new CodexEventMonitor({
      sessionsDir,
      store: inspection.store,
      onEvent,
    });
    monitors.push(monitor);

    const starting = monitor.start();
    await inspection.entered;
    await appendFile(file, `${questionLine('current-after-listing', now + 60_000)}\n`);
    try {
      await waitForStartupWatcher(monitor, file);
    } finally {
      inspection.release();
    }
    await starting;

    const fileCalls = onEvent.mock.calls.filter(([, filePath]) => filePath === file);
    expect(fileCalls).toEqual([
      [
        expect.objectContaining({ type: 'completed', turnId: 'old-completion' }),
        file,
        { mode: 'startup-catchup', notificationAllowed: false },
      ],
      [
        expect.objectContaining({ type: 'question', requestId: 'current-after-listing' }),
        file,
        { mode: 'startup-catchup', notificationAllowed: true },
      ],
    ]);
    await expectEofWithoutReplay(monitor, store, file, onEvent);
  });

  it('baselines an existing snapshotted path with no startup watcher event', async () => {
    const { file, monitor, onEvent, store } = await setup();
    await writeFile(file, `${completionLine('historical-only', Date.now() - 60_000)}\n`);
    await new Promise((resolve) => setTimeout(resolve, 50));

    await monitor.start();

    expect(onEvent).not.toHaveBeenCalled();
    await expectEofWithoutReplay(monitor, store, file, onEvent);
  });

  it('treats a path absent from the first snapshot and created during startup as unfiltered live', async () => {
    const { file, onEvent, sessionsDir, store } = await setup();
    await monitors.pop()?.stop();
    await writeFile(file, `${completionLine('historical-blocker', Date.now() - 60_000)}\n`);
    const inspection = barrierCursorStore(store, file);
    const monitor = new CodexEventMonitor({
      sessionsDir,
      store: inspection.store,
      onEvent,
    });
    monitors.push(monitor);
    const liveFile = join(dirname(file), 'rollout-created-after-snapshot.jsonl');

    const starting = monitor.start();
    await inspection.entered;
    await writeFile(
      liveFile,
      `${completionLine('live-with-old-timestamp', Date.now() - 60_000)}\n`,
    );
    try {
      await waitForStartupWatcher(monitor, liveFile);
    } finally {
      inspection.release();
    }
    await starting;

    const liveCalls = onEvent.mock.calls.filter(([, filePath]) => filePath === liveFile);
    expect(liveCalls).toEqual([[
      expect.objectContaining({ type: 'completed', turnId: 'live-with-old-timestamp' }),
      liveFile,
    ]]);
    await expectEofWithoutReplay(monitor, store, liveFile, onEvent);
  });

  it('lets a persisted cursor emit pre-start unread lifecycle events without startup filtering', async () => {
    const { file, monitor, onEvent, sessionsDir, store } = await setup();
    await writeFile(file, `${completionLine('initial-history', Date.now() - 120_000)}\n`);
    await monitor.processFile(file);
    await monitor.stop();
    monitors.splice(monitors.indexOf(monitor), 1);
    await appendFile(file, `${completionLine('daemon-downtime', Date.now() - 60_000)}\n`);
    const restarted = new CodexEventMonitor({ sessionsDir, store, onEvent });
    monitors.push(restarted);

    await restarted.start();

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'completed', turnId: 'daemon-downtime' }),
      file,
    );
    await expectEofWithoutReplay(restarted, store, file, onEvent);
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
    const sessionsDir = mkdtempSync(join(tmpdir(), 'cli2im-codex-startup-'));
    directories.push(sessionsDir);
    const nestedDir = join(sessionsDir, '2026', '07');
    await mkdir(nestedDir, { recursive: true });
    const file = join(nestedDir, 'rollout-startup.jsonl');
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

async function waitForStartupWatcher(
  monitor: CodexEventMonitor,
  file: string,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ((monitor as unknown as { rediscoverRequested: boolean }).rediscoverRequested) return;
    await appendFile(file, `${JSON.stringify({ startupWatcherProbe: attempt })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for startup watcher event');
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

function questionLine(requestId: string, occurredAt?: number): string {
  return JSON.stringify({
    type: 'response_item',
    ...(occurredAt === undefined ? {} : { timestamp: new Date(occurredAt).toISOString() }),
    payload: {
      type: 'function_call',
      name: 'request_user_input',
      call_id: requestId,
      arguments: JSON.stringify({ questions: [{ question: 'synthetic question' }] }),
      internal_chat_message_metadata_passthrough: { turn_id: `turn_${requestId}` },
    },
  });
}

function completionLine(turnId: string, occurredAt: number): string {
  return JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'task_complete',
      turn_id: turnId,
      completed_at: occurredAt,
    },
  });
}
