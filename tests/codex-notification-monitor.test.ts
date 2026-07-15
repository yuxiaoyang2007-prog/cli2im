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
    return { file, monitor, onEvent, store };
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
});
