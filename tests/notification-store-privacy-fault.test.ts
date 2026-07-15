import { join } from 'node:path';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodexNotificationEvent } from '../src/notifications/types.js';

const publishFault = vi.hoisted(() => ({
  failuresRemaining: 0,
  targetPath: '',
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: (
      oldPath: Parameters<typeof actual.renameSync>[0],
      newPath: Parameters<typeof actual.renameSync>[1],
    ) => {
      if (
        publishFault.failuresRemaining > 0
        && String(newPath) === publishFault.targetPath
        && String(oldPath).includes('.sessions.db.tmp-')
      ) {
        publishFault.failuresRemaining -= 1;
        throw Object.assign(new Error('synthetic main publication failure'), { code: 'EIO' });
      }
      return actual.renameSync(oldPath, newPath);
    },
  };
});

import { SessionStore } from '../src/session/store.js';

describe('SessionStore privacy publication continuation', () => {
  const directories: string[] = [];

  afterEach(() => {
    publishFault.failuresRemaining = 0;
    publishFault.targetPath = '';
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps sanitized-pair publication pending across repeated failure and a no-op retry', async () => {
    const { dbPath, marker, store, event } = await setup();
    publishFault.targetPath = dbPath;
    publishFault.failuresRemaining = 2;

    await expect(store.markNotificationFailed(event.eventKey)).rejects.toThrow(
      'synthetic main publication failure',
    );
    expectSnapshotMarker(dbPath, marker, true, false);

    await expect(store.markNotificationFailed(event.eventKey)).rejects.toThrow(
      'synthetic main publication failure',
    );
    expectSnapshotMarker(dbPath, marker, true, false);

    await store.upsertNotificationCursor({
      filePath: '/tmp/privacy-continuation.jsonl',
      fileId: '1:2',
      byteOffset: 1,
      continuityHash: '0123456789abcdef01234567',
      updatedAt: 4000,
    });
    store.close();

    expectSnapshotMarker(dbPath, marker, false, false);
  });

  it('recovers the sanitized backup after restart from an injected partial pair publication', async () => {
    const { dbPath, marker, store, event } = await setup();
    publishFault.targetPath = dbPath;
    publishFault.failuresRemaining = 1;

    await expect(store.markNotificationFailed(event.eventKey)).rejects.toThrow(
      'synthetic main publication failure',
    );
    store.close();
    expectSnapshotMarker(dbPath, marker, true, false);

    const recovered = await SessionStore.create(dbPath);
    expect(await recovered.listPendingNotifications()).toEqual([]);
    recovered.close();

    expectSnapshotMarker(dbPath, marker, false, false);
  });

  async function setup(): Promise<{
    dbPath: string;
    marker: string;
    store: SessionStore;
    event: CodexNotificationEvent;
  }> {
    const directory = mkdtempSync(join(tmpdir(), 'cli2im-privacy-fault-'));
    directories.push(directory);
    const dbPath = join(directory, 'sessions.db');
    const marker = 'PRIVACY_CONTINUATION_RAW_MARKER_0123456789';
    const event: CodexNotificationEvent = {
      eventKey: 'evt_privacy_continuation',
      kind: 'completed',
      sessionId: 'session_privacy',
      turnId: 'turn_privacy',
      projectName: marker,
      taskName: marker,
      surface: 'CLI',
      occurredAt: 1000,
      durationMs: 2500,
      shortTaskId: 'session_',
    };
    const store = await SessionStore.create(dbPath);
    await store.enqueueNotification(event);
    expect(readFileSync(dbPath).includes(Buffer.from(marker))).toBe(true);
    return { dbPath, marker, store, event };
  }
});

function expectSnapshotMarker(
  dbPath: string,
  marker: string,
  expectedLive: boolean,
  expectedBackup: boolean,
): void {
  const encoded = Buffer.from(marker);
  expect(readFileSync(dbPath).includes(encoded)).toBe(expectedLive);
  expect(readFileSync(`${dbPath}.bak`).includes(encoded)).toBe(expectedBackup);
}
