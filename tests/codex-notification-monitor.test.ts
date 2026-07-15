import { createRequire } from 'node:module';
import { appendFile, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import initSqlJs from 'sql.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexEventMonitor } from '../src/notifications/monitor.js';
import type { ParsedRolloutLine } from '../src/notifications/codex-events.js';
import { SessionStore } from '../src/session/store.js';

const require = createRequire(import.meta.url);
const sqlWasmDir = dirname(require.resolve('sql.js/dist/sql-wasm.wasm'));

const historicalCompletion = JSON.stringify({
  type: 'event_msg',
  payload: {
    type: 'task_complete',
    turn_id: 'turn_historical',
    completed_at: 1000,
  },
});

const questionLine = makeQuestionLine('call_synthetic');

describe('CodexEventMonitor', () => {
  const directories: string[] = [];
  const monitors: CodexEventMonitor[] = [];
  const stores: SessionStore[] = [];

  afterEach(async () => {
    await Promise.all(monitors.splice(0).map((monitor) => monitor.stop()));
    for (const store of stores.splice(0)) store.close();
    await Promise.all(directories.splice(0).map((directory) => (
      rm(directory, { recursive: true, force: true })
    )));
  });

  async function setup() {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'cli2im-codex-monitor-'));
    directories.push(sessionsDir);
    const nestedDir = join(sessionsDir, '2026', '07');
    await mkdir(nestedDir, { recursive: true });
    const file = join(nestedDir, 'rollout-synthetic.jsonl');
    const store = await SessionStore.create(':memory:');
    stores.push(store);
    const onEvent = vi.fn<(event: ParsedRolloutLine, filePath: string) => void>();
    const monitor = new CodexEventMonitor({ sessionsDir, store, onEvent });
    monitors.push(monitor);
    return { file, monitor, onEvent, sessionsDir, store };
  }

  it('baselines existing bytes and emits only appended events', async () => {
    const { file, monitor, onEvent } = await setup();
    await writeFile(file, `${historicalCompletion}\n`);

    await monitor.start();

    expect(onEvent).not.toHaveBeenCalled();
    await appendFile(file, `${questionLine}\n`);
    await monitor.processFile(file);
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'question' }),
      file,
    );
  });

  it('processes a rollout first created after watcher startup from byte zero', async () => {
    const { file, monitor, onEvent } = await setup();
    await monitor.start();
    const liveQuestion = makeQuestionLine('live-created-question');
    const liveCompletion = JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'turn_live_created',
        completed_at: 2000,
      },
    });

    await writeFile(file, `${liveQuestion}\n${liveCompletion}\n`);
    await waitFor(() => onEvent.mock.calls.length === 2);

    expect(onEvent.mock.calls.map(([event]) => event.type)).toEqual(['question', 'completed']);
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'question', requestId: 'live-created-question' }),
      file,
    );
  });

  it('suppresses slow non-atomic replacement history and resumes a later append', async () => {
    const { file, monitor, onEvent } = await setup();
    await writeFile(file, `${historicalCompletion}\n`);
    await monitor.start();
    const replacementHistory = makeQuestionLine('slow-replacement-history');
    const futureAppend = makeQuestionLine('after-slow-replacement');

    await writeFile(file, '');
    await new Promise((resolve) => setTimeout(resolve, 60));
    await appendFile(file, `${replacementHistory}\n`);
    await new Promise((resolve) => setTimeout(resolve, 350));

    expect(onEvent).not.toHaveBeenCalled();

    await appendFile(file, `${futureAppend}\n`);
    await waitFor(() => onEvent.mock.calls.length === 1);
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'question', requestId: 'after-slow-replacement' }),
      file,
    );
  });

  it('keeps an incomplete final line unread until the newline arrives', async () => {
    const { file, monitor, onEvent } = await setup();
    await writeFile(file, '');
    await monitor.start();

    await appendFile(file, questionLine.slice(0, 20));
    await monitor.processFile(file);
    expect(onEvent).not.toHaveBeenCalled();

    await appendFile(file, `${questionLine.slice(20)}\n`);
    await monitor.processFile(file);
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it('baselines a replacement inode instead of replaying it', async () => {
    const { file, monitor, onEvent } = await setup();
    await writeFile(file, `${historicalCompletion}\n`);
    await monitor.start();

    await rename(file, `${file}.old`);
    await writeFile(file, `${questionLine}\n`);
    await monitor.processFile(file);
    expect(onEvent).not.toHaveBeenCalled();

    await appendFile(file, `${questionLine}\n`);
    await monitor.processFile(file);
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it('persists byte offsets rather than decoded character counts', async () => {
    const { file, monitor, onEvent, store } = await setup();
    await writeFile(file, '');
    await monitor.start();
    const multibyteIgnoredLine = JSON.stringify({ synthetic: '這是多字節' });

    await appendFile(file, `${multibyteIgnoredLine}\n${questionLine}\n`);
    await monitor.processFile(file);

    expect(onEvent).toHaveBeenCalledTimes(1);
    const cursor = await store.getNotificationCursor(file);
    expect(cursor?.byteOffset).toBe((await stat(file)).size);
  });

  it('opens before cursor lookup and baselines a replacement raced into the path', async () => {
    const { file, onEvent, sessionsDir, store } = await setup();
    const historical = `${historicalCompletion}\n`;
    await writeFile(file, historical);
    await monitors.pop()?.stop();

    const baseline = new CodexEventMonitor({ sessionsDir, store, onEvent });
    monitors.push(baseline);
    await baseline.processFile(file);
    await appendFile(file, `${JSON.stringify({ padding: 'x'.repeat(questionLine.length) })}\n`);

    let replaced = false;
    const racingStore = {
      getNotificationCursor: async (filePath: string) => {
        const cursor = await store.getNotificationCursor(filePath);
        if (!replaced) {
          replaced = true;
          await rename(file, `${file}.raced-old`);
          await writeFile(file, `${historical}${questionLine}\n`);
        }
        return cursor;
      },
      upsertNotificationCursor: store.upsertNotificationCursor.bind(store),
    };
    const racingMonitor = new CodexEventMonitor({ sessionsDir, store: racingStore, onEvent });
    monitors.push(racingMonitor);

    await racingMonitor.processFile(file);

    expect(onEvent).not.toHaveBeenCalled();
    const replacementStat = await stat(file);
    expect(await store.getNotificationCursor(file)).toMatchObject({
      fileId: `${replacementStat.dev}:${replacementStat.ino}`,
      byteOffset: replacementStat.size,
    });
  });

  it('baselines same-inode truncate and regrow instead of replaying replacement history', async () => {
    const { file, monitor, onEvent, store } = await setup();
    const historical = `${historicalCompletion}\n`;
    await writeFile(file, historical);
    await monitor.processFile(file);
    const original = await stat(file);

    await writeFile(file, `${'x'.repeat(Buffer.byteLength(historical))}${questionLine}\n`);
    const replacement = await stat(file);
    expect(replacement.ino).toBe(original.ino);

    await monitor.processFile(file);
    expect(onEvent).not.toHaveBeenCalled();
    expect(await store.getNotificationCursor(file)).toMatchObject({
      fileId: `${replacement.dev}:${replacement.ino}`,
      byteOffset: replacement.size,
      continuityHash: expect.stringMatching(/^[a-f0-9]{24}$/),
    });

    await appendFile(file, `${questionLine}\n`);
    await monitor.processFile(file);
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it('resumes normal appends from a persisted continuity cursor after restart', async () => {
    const { file, monitor, onEvent, sessionsDir, store } = await setup();
    await writeFile(file, `${historicalCompletion}\n`);
    await monitor.processFile(file);
    await monitor.stop();
    monitors.splice(monitors.indexOf(monitor), 1);

    const restarted = new CodexEventMonitor({ sessionsDir, store, onEvent });
    monitors.push(restarted);
    await appendFile(file, `${questionLine}\n`);
    await restarted.processFile(file);

    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it('persists snapshot continuity when onEvent truncates and regrows the same inode', async () => {
    const { file, sessionsDir, store } = await setup();
    await monitors.pop()?.stop();
    const historical = `${historicalCompletion}\n`;
    const oldAppended = makeQuestionLine('old-appended');
    const replacementHistory = makeQuestionLine('replacement-history');
    const normalAppend = makeQuestionLine('normal-append');
    await writeFile(file, historical);
    let replacementContent = '';
    const requestIds: string[] = [];
    const onEvent = vi.fn(async (event: ParsedRolloutLine) => {
      if (event.type !== 'question') return;
      requestIds.push(event.requestId);
      if (event.requestId === 'old-appended') await writeFile(file, replacementContent);
    });
    const monitor = new CodexEventMonitor({ sessionsDir, store, onEvent });
    monitors.push(monitor);
    await monitor.processFile(file);
    const original = await stat(file);
    const snapshottedOffset = Buffer.byteLength(`${historical}${oldAppended}\n`);
    replacementContent = `${'x'.repeat(snapshottedOffset)}${replacementHistory}\n`;

    await appendFile(file, `${oldAppended}\n`);
    await monitor.processFile(file);
    expect((await stat(file)).ino).toBe(original.ino);
    expect(requestIds).toEqual(['old-appended']);

    await monitor.processFile(file);
    expect(requestIds).toEqual(['old-appended']);

    await appendFile(file, `${normalAppend}\n`);
    await monitor.processFile(file);
    expect(requestIds).toEqual(['old-appended', 'normal-append']);
  });

  it('fail-closed baselines replacement history behind a migrated hashless cursor', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'cli2im-codex-monitor-'));
    directories.push(sessionsDir);
    const nestedDir = join(sessionsDir, '2026', '07');
    await mkdir(nestedDir, { recursive: true });
    const file = join(nestedDir, 'rollout-legacy.jsonl');
    const historical = `${historicalCompletion}\n`;
    const legacyReplacement = makeQuestionLine('legacy-replacement-history');
    const normalAppend = makeQuestionLine('legacy-normal-append');
    await writeFile(file, `${historical}${legacyReplacement}\n`);
    const fileStat = await stat(file);
    const dbPath = join(sessionsDir, 'legacy.db');
    const SQL = await initSqlJs({
      locateFile: (name: string) => join(sqlWasmDir, name),
    });
    const legacyDb = new SQL.Database();
    legacyDb.run(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        key TEXT UNIQUE NOT NULL,
        agent_name TEXT NOT NULL,
        agent_session_id TEXT,
        working_directory TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL
      )
    `);
    legacyDb.run(`
      CREATE TABLE notification_cursors (
        file_path TEXT PRIMARY KEY,
        file_id TEXT NOT NULL,
        byte_offset INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    legacyDb.run(
      'INSERT INTO notification_cursors (file_path, file_id, byte_offset, updated_at) VALUES (?, ?, ?, ?)',
      [file, `${fileStat.dev}:${fileStat.ino}`, Buffer.byteLength(historical), 10],
    );
    await writeFile(dbPath, Buffer.from(legacyDb.export()));
    legacyDb.close();
    const store = await SessionStore.create(dbPath);
    stores.push(store);
    const onEvent = vi.fn<(event: ParsedRolloutLine, filePath: string) => void>();
    const monitor = new CodexEventMonitor({ sessionsDir, store, onEvent });
    monitors.push(monitor);

    await monitor.processFile(file);

    expect(onEvent).not.toHaveBeenCalled();
    expect(await store.getNotificationCursor(file)).toMatchObject({
      byteOffset: fileStat.size,
      continuityHash: expect.stringMatching(/^[a-f0-9]{24}$/),
    });

    await appendFile(file, `${normalAppend}\n`);
    await monitor.processFile(file);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'question', requestId: 'legacy-normal-append' }),
      file,
    );
  });

  it('cleans up a failed discovery so a later start can discover files', async () => {
    const { file, onEvent, sessionsDir, store } = await setup();
    await monitors.pop()?.stop();
    await writeFile(file, `${historicalCompletion}\n`);
    let fail = true;
    const failingStore = {
      getNotificationCursor: async (filePath: string) => {
        if (fail) throw new Error('synthetic discovery failure');
        return store.getNotificationCursor(filePath);
      },
      upsertNotificationCursor: store.upsertNotificationCursor.bind(store),
    };
    const monitor = new CodexEventMonitor({ sessionsDir, store: failingStore, onEvent });
    monitors.push(monitor);

    await expect(monitor.start()).rejects.toThrow('synthetic discovery failure');
    fail = false;
    await monitor.start();

    expect(await store.getNotificationCursor(file)).not.toBeNull();
  });

  it('makes concurrent starts share the same discovery failure', async () => {
    const { file, onEvent, sessionsDir, store } = await setup();
    await monitors.pop()?.stop();
    await writeFile(file, `${historicalCompletion}\n`);
    let enteredResolve!: () => void;
    let releaseResolve!: () => void;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
    const blockingStore = {
      getNotificationCursor: async (_filePath: string) => {
        enteredResolve();
        await release;
        throw new Error('synthetic shared failure');
      },
      upsertNotificationCursor: store.upsertNotificationCursor.bind(store),
    };
    const monitor = new CodexEventMonitor({ sessionsDir, store: blockingStore, onEvent });
    monitors.push(monitor);

    const first = monitor.start();
    await entered;
    const second = monitor.start();
    releaseResolve();
    const results = await Promise.allSettled([first, second]);

    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
  });

  it('leaves no watcher active when stop races a pending start', async () => {
    const { file, onEvent, sessionsDir, store } = await setup();
    await monitors.pop()?.stop();
    await writeFile(file, `${historicalCompletion}\n`);
    let enteredResolve!: () => void;
    let releaseResolve!: () => void;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
    const blockingStore = {
      getNotificationCursor: async (filePath: string) => {
        enteredResolve();
        await release;
        return store.getNotificationCursor(filePath);
      },
      upsertNotificationCursor: store.upsertNotificationCursor.bind(store),
    };
    const monitor = new CodexEventMonitor({ sessionsDir, store: blockingStore, onEvent });
    monitors.push(monitor);

    const starting = monitor.start();
    await entered;
    const stopping = monitor.stop();
    releaseResolve();
    await Promise.all([starting, stopping]);
    const laterFile = join(sessionsDir, '2026', '07', 'rollout-after-stop.jsonl');
    await writeFile(laterFile, `${historicalCompletion}\n`);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(await store.getNotificationCursor(laterFile)).toBeNull();
  });

  it('serializes concurrent rediscovery scans', async () => {
    const { file, onEvent, sessionsDir, store } = await setup();
    await monitors.pop()?.stop();
    await writeFile(file, `${historicalCompletion}\n`);
    let block = false;
    let active = 0;
    let maxActive = 0;
    let enteredResolve!: () => void;
    let releaseResolve!: () => void;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
    const blockingStore = {
      getNotificationCursor: async (filePath: string) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (block) {
          enteredResolve();
          await release;
        }
        try {
          return await store.getNotificationCursor(filePath);
        } finally {
          active -= 1;
        }
      },
      upsertNotificationCursor: store.upsertNotificationCursor.bind(store),
      upsertNotificationCursors: store.upsertNotificationCursors.bind(store),
    };
    const monitor = new CodexEventMonitor({ sessionsDir, store: blockingStore, onEvent });
    monitors.push(monitor);
    await monitor.start();
    block = true;
    const discover = (monitor as unknown as { discoverFiles(): Promise<void> }).discoverFiles.bind(
      monitor,
    );

    const first = discover();
    await entered;
    const second = discover();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(maxActive).toBe(1);

    releaseResolve();
    await Promise.all([first, second]);
  });

  it('drains an in-flight rediscovery before stop resolves and starts no later work', async () => {
    const { file, onEvent, sessionsDir, store } = await setup();
    await monitors.pop()?.stop();
    const monitor = new CodexEventMonitor({
      sessionsDir,
      store: {
        getNotificationCursor: async (filePath: string) => {
          enteredResolve();
          await release;
          return store.getNotificationCursor(filePath);
        },
        upsertNotificationCursor: store.upsertNotificationCursor.bind(store),
        upsertNotificationCursors: store.upsertNotificationCursors.bind(store),
      },
      onEvent,
    });
    monitors.push(monitor);
    let enteredResolve!: () => void;
    let releaseResolve!: () => void;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
    await monitor.start();
    await writeFile(file, `${makeQuestionLine('stop-drain-live')}\n`);
    const discover = (monitor as unknown as { discoverFiles(): Promise<void> }).discoverFiles.bind(
      monitor,
    );
    const scanning = discover();
    await entered;

    const stopping = monitor.stop();
    const earlyResult = await Promise.race([
      stopping.then(() => 'stopped'),
      new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 30)),
    ]);
    expect(earlyResult).toBe('waiting');

    releaseResolve();
    await Promise.all([scanning, stopping]);
    const callsAfterStop = onEvent.mock.calls.length;
    const cursorAfterStop = await store.getNotificationCursor(file);
    await appendFile(file, `${makeQuestionLine('after-stop')}\n`);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(onEvent).toHaveBeenCalledTimes(callsAfterStop);
    expect(await store.getNotificationCursor(file)).toEqual(cursorAfterStop);
  });

  it('loops over same-inode growth that occurs during a discovery callback', async () => {
    const { file, sessionsDir, store } = await setup();
    await monitors.pop()?.stop();
    await writeFile(file, `${historicalCompletion}\n`);
    const first = makeQuestionLine('scan-growth-first');
    const second = makeQuestionLine('scan-growth-second');
    const requestIds: string[] = [];
    const onEvent = vi.fn(async (event: ParsedRolloutLine) => {
      if (event.type !== 'question') return;
      requestIds.push(event.requestId);
      if (event.requestId === 'scan-growth-first') await appendFile(file, `${second}\n`);
    });
    const monitor = new CodexEventMonitor({ sessionsDir, store, onEvent });
    monitors.push(monitor);
    await monitor.processFile(file);
    await appendFile(file, `${first}\n`);

    await (monitor as unknown as { discoverFiles(): Promise<void> }).discoverFiles();

    expect(requestIds).toEqual(['scan-growth-first', 'scan-growth-second']);
  });

  it('discovers rollout files sequentially and durably baselines them with one save', async () => {
    const { onEvent, sessionsDir, store } = await setup();
    await monitors.pop()?.stop();
    const nestedDir = join(sessionsDir, '2026', '07');
    const files = Array.from({ length: 24 }, (_, index) => (
      join(nestedDir, `rollout-batch-${index}.jsonl`)
    ));
    await Promise.all(files.map((file) => writeFile(file, `${historicalCompletion}\n`)));
    let activeLookups = 0;
    let maxActiveLookups = 0;
    const save = vi.spyOn(store, 'save');
    const boundedStore = {
      getNotificationCursor: async (filePath: string) => {
        activeLookups += 1;
        maxActiveLookups = Math.max(maxActiveLookups, activeLookups);
        await new Promise((resolve) => setTimeout(resolve, 1));
        try {
          return await store.getNotificationCursor(filePath);
        } finally {
          activeLookups -= 1;
        }
      },
      upsertNotificationCursor: store.upsertNotificationCursor.bind(store),
      upsertNotificationCursors: store.upsertNotificationCursors.bind(store),
    };
    const monitor = new CodexEventMonitor({ sessionsDir, store: boundedStore, onEvent });
    monitors.push(monitor);

    await monitor.start();

    expect(maxActiveLookups).toBe(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(onEvent).not.toHaveBeenCalled();
    expect(await Promise.all(files.map((file) => store.getNotificationCursor(file)))).not.toContain(null);
  });

  it('reads a large append in fixed chunks and persists at most once per processed chunk', async () => {
    const { file, monitor, onEvent, store } = await setup();
    await writeFile(file, '');
    await monitor.processFile(file);
    const ignoredLine = `${JSON.stringify({ synthetic: '界'.repeat(600) })}\n`;
    const appended = `${ignoredLine.repeat(180)}${questionLine}\n`;
    const save = vi.spyOn(store, 'save');
    const allocate = vi.spyOn(Buffer, 'alloc');
    await appendFile(file, appended);
    let allocations: number[] = [];

    try {
      await monitor.processFile(file);
      allocations = allocate.mock.calls
        .map((call) => call[0])
        .filter((size): size is number => typeof size === 'number');
    } finally {
      allocate.mockRestore();
    }

    expect(Math.max(...allocations)).toBeLessThanOrEqual(64 * 1024);
    expect(save.mock.calls.length).toBeLessThanOrEqual(
      Math.ceil(Buffer.byteLength(appended) / (64 * 1024)) + 1,
    );
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect((await store.getNotificationCursor(file))?.byteOffset).toBe((await stat(file)).size);
  });

  it('preserves a valid UTF-8 JSON line split across read and newline boundaries', async () => {
    const { file, monitor, onEvent, store } = await setup();
    await writeFile(file, '');
    await monitor.processFile(file);
    const splitLine = makeQuestionLine('utf8-split', '界'.repeat(30_000));

    await appendFile(file, `${splitLine}\n`);
    await monitor.processFile(file);

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'question', requestId: 'utf8-split' }),
      file,
    );
    expect((await store.getNotificationCursor(file))?.byteOffset).toBe((await stat(file)).size);
  });

  it('bounds an oversized line and still processes the following valid lifecycle line', async () => {
    const { file, monitor, onEvent, store } = await setup();
    await writeFile(file, '');
    await monitor.processFile(file);
    const oversized = `${JSON.stringify({ synthetic: 'x'.repeat(1_100_000) })}\n`;
    const appended = `${oversized}${makeQuestionLine('after-oversized')}\n`;
    const allocate = vi.spyOn(Buffer, 'alloc');
    await appendFile(file, appended);
    let allocations: number[] = [];

    try {
      await monitor.processFile(file);
      allocations = allocate.mock.calls
        .map((call) => call[0])
        .filter((size): size is number => typeof size === 'number');
    } finally {
      allocate.mockRestore();
    }

    expect(Math.max(...allocations)).toBeLessThanOrEqual(64 * 1024);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'question', requestId: 'after-oversized' }),
      file,
    );
    expect((await store.getNotificationCursor(file))?.byteOffset).toBe((await stat(file)).size);
  });
});

function makeQuestionLine(requestId: string, question = 'synthetic question'): string {
  return JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'request_user_input',
      call_id: requestId,
      arguments: JSON.stringify({ questions: [{ question }] }),
      internal_chat_message_metadata_passthrough: { turn_id: `turn_${requestId}` },
    },
  });
}

async function waitFor(condition: () => boolean, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for monitor event');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
