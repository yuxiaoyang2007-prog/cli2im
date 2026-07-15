import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import initSqlJs from 'sql.js';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionStore } from '../src/session/store.js';
import type { CodexNotificationEvent } from '../src/notifications/types.js';

const require = createRequire(import.meta.url);
const sqlWasmDir = dirname(require.resolve('sql.js/dist/sql-wasm.wasm'));

interface ReadOnlyTestDatabase {
  exec(sql: string): Array<{ values: unknown[][] }>;
  close(): void;
}

function completionEvent(
  overrides: Partial<CodexNotificationEvent> = {},
): CodexNotificationEvent {
  return {
    eventKey: 'evt_default',
    kind: 'completed',
    sessionId: 'session_1',
    turnId: 'turn_1',
    projectName: 'cli2im',
    taskName: '通知测试',
    surface: 'CLI',
    occurredAt: 1000,
    durationMs: 2500,
    shortTaskId: 'session_',
    ...overrides,
  };
}

describe('notification persistence', () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('replaces one bot private-chat binding without creating duplicates', async () => {
    const store = await SessionStore.create(':memory:');
    await store.bindNotificationTarget({
      botName: 'codexbot',
      platform: 'feishu',
      chatId: 'oc_first',
      userId: 'ou_user',
      updatedAt: 10,
    });
    await store.bindNotificationTarget({
      botName: 'codexbot',
      platform: 'feishu',
      chatId: 'oc_second',
      userId: 'ou_user',
      updatedAt: 20,
    });

    expect(await store.getNotificationBinding('codexbot')).toEqual({
      botName: 'codexbot',
      platform: 'feishu',
      chatId: 'oc_second',
      userId: 'ou_user',
      updatedAt: 20,
    });
    expect(await store.getNotificationBinding('missing')).toBeNull();
    store.close();
  });

  it('persists a byte cursor by file identity', async () => {
    const store = await SessionStore.create(':memory:');
    await store.upsertNotificationCursor({
      filePath: '/tmp/rollout.jsonl',
      fileId: '1:2',
      byteOffset: 24,
      updatedAt: 10,
    });
    await store.upsertNotificationCursor({
      filePath: '/tmp/rollout.jsonl',
      fileId: '1:2',
      byteOffset: 48,
      updatedAt: 20,
    });

    expect(await store.getNotificationCursor('/tmp/rollout.jsonl')).toEqual({
      filePath: '/tmp/rollout.jsonl',
      fileId: '1:2',
      byteOffset: 48,
      updatedAt: 20,
    });
    expect(await store.getNotificationCursor('/tmp/missing.jsonl')).toBeNull();
    store.close();
  });

  it('migrates legacy cursors and persists an optional continuity hash', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cli2im-notification-store-'));
    temporaryDirectories.push(directory);
    const dbPath = join(directory, 'sessions.db');
    const SQL = await initSqlJs({
      locateFile: (file: string) => join(sqlWasmDir, file),
    });
    const legacyDb = new SQL.Database();
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
      ['/tmp/rollout-legacy.jsonl', '1:2', 24, 10],
    );
    writeFileSync(dbPath, Buffer.from(legacyDb.export()));
    legacyDb.close();

    const store = await SessionStore.create(dbPath);
    expect(await store.getNotificationCursor('/tmp/rollout-legacy.jsonl')).toEqual({
      filePath: '/tmp/rollout-legacy.jsonl',
      fileId: '1:2',
      byteOffset: 24,
      updatedAt: 10,
    });

    await store.upsertNotificationCursor({
      filePath: '/tmp/rollout-legacy.jsonl',
      fileId: '1:2',
      byteOffset: 48,
      continuityHash: '0123456789abcdef01234567',
      updatedAt: 20,
    });
    expect(await store.getNotificationCursor('/tmp/rollout-legacy.jsonl')).toEqual({
      filePath: '/tmp/rollout-legacy.jsonl',
      fileId: '1:2',
      byteOffset: 48,
      continuityHash: '0123456789abcdef01234567',
      updatedAt: 20,
    });
    store.close();
  });

  it('enqueues one delivery per event key and reloads pending payload', async () => {
    const store = await SessionStore.create(':memory:');
    const event = completionEvent({ eventKey: 'evt_1' });

    expect(await store.enqueueNotification(event)).toBe(true);
    expect(await store.enqueueNotification(event)).toBe(false);
    expect(await store.listPendingNotifications()).toEqual([
      {
        event,
        status: 'pending',
        attempts: 0,
        nextRetryAt: null,
        deliveredAt: null,
      },
    ]);
    store.close();
  });

  it('reloads pending payload and retry state from disk', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cli2im-notification-store-'));
    temporaryDirectories.push(directory);
    const dbPath = join(directory, 'sessions.db');
    const event = completionEvent({ eventKey: 'evt_retry' });

    const firstStore = await SessionStore.create(dbPath);
    await firstStore.enqueueNotification(event);
    await firstStore.markNotificationAttempt(event.eventKey, 2000);
    firstStore.close();

    const reloadedStore = await SessionStore.create(dbPath);
    expect(await reloadedStore.listPendingNotifications()).toEqual([
      {
        event,
        status: 'pending',
        attempts: 1,
        nextRetryAt: 2000,
        deliveredAt: null,
      },
    ]);
    reloadedStore.close();
  });

  it('clears a delivered payload while retaining its dedupe key and timestamp', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cli2im-notification-store-'));
    temporaryDirectories.push(directory);
    const dbPath = join(directory, 'sessions.db');
    const store = await SessionStore.create(dbPath);
    const delivered = completionEvent({ eventKey: 'evt_delivered' });
    await store.enqueueNotification(delivered);
    await store.markNotificationDelivered(delivered.eventKey, 3000);
    store.close();

    const SQL = await initSqlJs({
      locateFile: (file: string) => join(sqlWasmDir, file),
    });
    const db = new SQL.Database(readFileSync(dbPath)) as unknown as ReadOnlyTestDatabase;
    const [result] = db.exec(
      'SELECT event_key, event_json, status, next_retry_at, delivered_at FROM notification_deliveries',
    );
    expect(result.values).toEqual([
      ['evt_delivered', '{}', 'delivered', null, 3000],
    ]);
    db.close();
  });

  it('persists failed and discarded terminal statuses outside the pending queue', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cli2im-notification-store-'));
    temporaryDirectories.push(directory);
    const dbPath = join(directory, 'sessions.db');
    const store = await SessionStore.create(dbPath);
    const failed = completionEvent({ eventKey: 'evt_failed' });
    const discarded = completionEvent({ eventKey: 'evt_discarded' });
    await store.enqueueNotification(failed);
    await store.enqueueNotification(discarded);

    await store.markNotificationFailed(failed.eventKey);
    await store.markNotificationFailed(discarded.eventKey, 'discarded');
    store.close();

    const reloadedStore = await SessionStore.create(dbPath);
    expect(await reloadedStore.listPendingNotifications()).toEqual([]);
    expect(await reloadedStore.enqueueNotification(failed)).toBe(false);
    expect(await reloadedStore.enqueueNotification(discarded)).toBe(false);
    reloadedStore.close();

    const SQL = await initSqlJs({
      locateFile: (file: string) => join(sqlWasmDir, file),
    });
    const db = new SQL.Database(readFileSync(dbPath)) as unknown as ReadOnlyTestDatabase;
    const [result] = db.exec(
      'SELECT event_key, status, next_retry_at FROM notification_deliveries ORDER BY event_key',
    );
    expect(result.values).toEqual([
      ['evt_discarded', 'discarded', null],
      ['evt_failed', 'failed', null],
    ]);
    db.close();
  });
});
