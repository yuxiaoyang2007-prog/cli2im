import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexNotificationOutbox } from '../src/notifications/outbox.js';
import type { StructuredLifecycleEvent } from '../src/notifications/lifecycle-protocol.js';
import { listOutboxEvents, writeOutboxEvent } from '../src/notifications/task-state-files.js';

describe('Codex notification outbox drain', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function setup() {
    const root = await mkdtemp(join(tmpdir(), 'cli2im-outbox-'));
    roots.push(root);
    const event: StructuredLifecycleEvent = {
      version: 1, type: 'status_tool', eventKey: 'event_1', sessionId: 'session_1',
      turnId: 'turn_1', toolUseId: 'tool_1', status: 'completed', occurredAt: Date.now(),
    };
    await writeOutboxEvent(root, event);
    return { root, event };
  }

  it('drains startup events once after durable handling', async () => {
    const { root, event } = await setup();
    const handle = vi.fn(async () => 'delivered' as const);
    const outbox = new CodexNotificationOutbox({ dataRoot: root, handle, intervalMs: 20 });
    await outbox.start();
    await outbox.stop();

    expect(handle).toHaveBeenCalledWith(event);
    expect(await listOutboxEvents(root)).toHaveLength(0);
  });

  it('retains events when handling fails', async () => {
    const { root } = await setup();
    const outbox = new CodexNotificationOutbox({
      dataRoot: root, handle: async () => 'failed', intervalMs: 20,
    });
    await outbox.start();
    await outbox.stop();
    expect(await listOutboxEvents(root)).toHaveLength(1);
  });
});
