import { appendFile, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexEventMonitor } from '../src/notifications/monitor.js';
import type { ParsedRolloutLine } from '../src/notifications/codex-events.js';
import { SessionStore } from '../src/session/store.js';

const historicalCompletion = JSON.stringify({
  type: 'event_msg',
  payload: {
    type: 'task_complete',
    turn_id: 'turn_historical',
    completed_at: 1000,
  },
});

const questionLine = JSON.stringify({
  type: 'response_item',
  payload: {
    type: 'function_call',
    name: 'request_user_input',
    call_id: 'call_synthetic',
    arguments: '{"questions":[{"question":"synthetic question"}]}',
    internal_chat_message_metadata_passthrough: { turn_id: 'turn_synthetic' },
  },
});

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
});
