import { createRequire } from 'node:module';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
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
        firstAttemptAt: null,
        lastAttemptAt: null,
        nextRetryAt: null,
        deliveredAt: null,
        transportMessageId: null,
        acknowledgedAt: null,
        delayedPatchCompletedAt: null,
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
    await firstStore.markNotificationAttemptStarted(event.eventKey, 1500);
    await firstStore.markNotificationAttemptStarted(event.eventKey, 1750);
    await firstStore.setNotificationNextRetry(event.eventKey, 2000);
    await firstStore.recordNotificationReceipt(event.eventKey, 'om_receipt', 1800);
    await firstStore.recordNotificationReceipt(event.eventKey, 'om_ignored', 1900);
    await firstStore.markNotificationDelayedPatchCompleted(event.eventKey, 1950);
    firstStore.close();

    const reloadedStore = await SessionStore.create(dbPath);
    expect(await reloadedStore.listPendingNotifications()).toEqual([
      {
        event,
        status: 'pending',
        attempts: 2,
        firstAttemptAt: 1500,
        lastAttemptAt: 1750,
        nextRetryAt: null,
        deliveredAt: null,
        transportMessageId: 'om_receipt',
        acknowledgedAt: 1800,
        delayedPatchCompletedAt: 1950,
      },
    ]);
    reloadedStore.close();
  });

  it('migrates old delivery rows with unverifiable attempt and card state', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cli2im-notification-store-'));
    temporaryDirectories.push(directory);
    const dbPath = join(directory, 'sessions.db');
    const event = completionEvent({ eventKey: 'evt_legacy_delivery' });
    const SQL = await initSqlJs({
      locateFile: (file: string) => join(sqlWasmDir, file),
    });
    const legacyDb = new SQL.Database();
    legacyDb.run(`
      CREATE TABLE notification_deliveries (
        event_key TEXT PRIMARY KEY,
        event_json TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        next_retry_at INTEGER,
        delivered_at INTEGER
      )
    `);
    legacyDb.run(
      `INSERT INTO notification_deliveries
         (event_key, event_json, status, attempts, next_retry_at, delivered_at)
       VALUES (?, ?, 'pending', 1, 2000, NULL)`,
      [event.eventKey, JSON.stringify(event)],
    );
    writeFileSync(dbPath, Buffer.from(legacyDb.export()));
    legacyDb.close();

    const store = await SessionStore.create(dbPath);
    expect(await store.listPendingNotifications()).toEqual([
      {
        event,
        status: 'pending',
        attempts: 1,
        firstAttemptAt: null,
        lastAttemptAt: null,
        nextRetryAt: 2000,
        deliveredAt: null,
        transportMessageId: null,
        acknowledgedAt: null,
        delayedPatchCompletedAt: null,
      },
    ]);
    store.close();

    const migratedDb = new SQL.Database(readFileSync(dbPath)) as unknown as ReadOnlyTestDatabase;
    const [columns] = migratedDb.exec('PRAGMA table_info(notification_deliveries)');
    expect(columns.values.map((column) => column[1])).toEqual(expect.arrayContaining([
      'last_attempt_at',
      'delayed',
      'first_attempt_at',
      'transport_message_id',
      'acknowledged_at',
      'delayed_patch_completed_at',
    ]));
    migratedDb.close();
  });

  it('clears all non-dedupe delivery metadata after retaining the key and delivered timestamp', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cli2im-notification-store-'));
    temporaryDirectories.push(directory);
    const dbPath = join(directory, 'sessions.db');
    const store = await SessionStore.create(dbPath);
    const delivered = completionEvent({ eventKey: 'evt_delivered' });
    await store.enqueueNotification(delivered);
    await store.markNotificationAttemptStarted(delivered.eventKey, 1500);
    await store.recordNotificationReceipt(delivered.eventKey, 'om_delivered', 1800);
    await store.markNotificationDelayedPatchCompleted(delivered.eventKey, 1900);
    store.close();

    const SQL = await initSqlJs({
      locateFile: (file: string) => join(sqlWasmDir, file),
    });
    const intermediateDb = new SQL.Database(readFileSync(dbPath));
    intermediateDb.run(
      'UPDATE notification_deliveries SET delayed = 1 WHERE event_key = ?',
      [delivered.eventKey],
    );
    writeFileSync(dbPath, Buffer.from(intermediateDb.export()));
    intermediateDb.close();

    const reloadedStore = await SessionStore.create(dbPath);
    await reloadedStore.markNotificationDelivered(delivered.eventKey, 3000);
    reloadedStore.close();

    const verifiedDb = new SQL.Database(readFileSync(dbPath)) as unknown as ReadOnlyTestDatabase;
    const [result] = verifiedDb.exec(
      `SELECT event_key, event_json, status, attempts, first_attempt_at,
              last_attempt_at, next_retry_at, delivered_at, delayed,
              transport_message_id, acknowledged_at, delayed_patch_completed_at
       FROM notification_deliveries`,
    );
    expect(result.values).toEqual([
      [
        'evt_delivered', '{}', 'delivered', 0, null, null,
        null, 3000, null, null, null, null,
      ],
    ]);
    verifiedDb.close();
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
    for (const event of [failed, discarded]) {
      await store.markNotificationAttemptStarted(event.eventKey, 1500);
      await store.setNotificationNextRetry(event.eventKey, 2000);
      await store.recordNotificationReceipt(event.eventKey, `om_${event.eventKey}`, 1800);
      await store.markNotificationDelayedPatchCompleted(event.eventKey, 1900);
    }
    store.close();

    const SQL = await initSqlJs({
      locateFile: (file: string) => join(sqlWasmDir, file),
    });
    const intermediate = new SQL.Database(readFileSync(dbPath));
    intermediate.run('UPDATE notification_deliveries SET delayed = 1');
    writeFileSync(dbPath, Buffer.from(intermediate.export()));
    intermediate.close();

    const terminalStore = await SessionStore.create(dbPath);
    await terminalStore.markNotificationFailed(failed.eventKey);
    await terminalStore.markNotificationFailed(discarded.eventKey, 'discarded');
    terminalStore.close();

    const reloadedStore = await SessionStore.create(dbPath);
    expect(await reloadedStore.listPendingNotifications()).toEqual([]);
    expect(await reloadedStore.enqueueNotification(failed)).toBe(false);
    expect(await reloadedStore.enqueueNotification(discarded)).toBe(false);
    reloadedStore.close();

    const db = new SQL.Database(readFileSync(dbPath)) as unknown as ReadOnlyTestDatabase;
    const [result] = db.exec(
      `SELECT event_key, event_json, status, attempts, first_attempt_at,
              last_attempt_at, next_retry_at, delivered_at, delayed,
              transport_message_id, acknowledged_at, delayed_patch_completed_at
       FROM notification_deliveries ORDER BY event_key`,
    );
    expect(result.values).toEqual([
      ['evt_discarded', '{}', 'discarded', 0, null, null, null, null, null, null, null, null],
      ['evt_failed', '{}', 'failed', 0, null, null, null, null, null, null, null, null],
    ]);
    db.close();

    const backup = new SQL.Database(
      readFileSync(`${dbPath}.bak`),
    ) as unknown as ReadOnlyTestDatabase;
    const [backupResult] = backup.exec(
      `SELECT event_key, event_json, status, attempts, first_attempt_at,
              last_attempt_at, next_retry_at, delivered_at, delayed,
              transport_message_id, acknowledged_at, delayed_patch_completed_at
       FROM notification_deliveries ORDER BY event_key`,
    );
    expect(backupResult.values).toEqual(result.values);
    backup.close();
  });

  it('keeps live, temporary, and backup database snapshots owner-only', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cli2im-notification-store-'));
    temporaryDirectories.push(directory);
    const dbPath = join(directory, 'sessions.db');
    const first = completionEvent({ eventKey: 'evt_mode_first' });
    const second = completionEvent({ eventKey: 'evt_mode_second' });

    const store = await SessionStore.create(dbPath);
    await store.enqueueNotification(first);
    chmodSync(dbPath, 0o644);
    store.close();

    const reopened = await SessionStore.create(dbPath);
    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
    await reopened.enqueueNotification(second);
    reopened.close();

    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
    expect(statSync(`${dbPath}.bak`).mode & 0o777).toBe(0o600);
    expect(readdirSync(directory).filter((name) => name.includes('.tmp-'))).toEqual([]);
  });

  it('leaves the live database intact when publishing the backup fails', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cli2im-notification-store-'));
    temporaryDirectories.push(directory);
    const dbPath = join(directory, 'sessions.db');
    const store = await SessionStore.create(dbPath);
    await store.enqueueNotification(completionEvent({ eventKey: 'evt_before_failed_save' }));
    const liveBefore = readFileSync(dbPath);
    mkdirSync(`${dbPath}.bak`);
    writeFileSync(join(`${dbPath}.bak`, 'blocker'), 'block replacement');

    await expect(store.enqueueNotification(
      completionEvent({ eventKey: 'evt_failed_save' }),
    )).rejects.toThrow();

    expect(readFileSync(dbPath)).toEqual(liveBefore);
    expect(readdirSync(directory).filter((name) => name.includes('.tmp-'))).toEqual([]);
    store.close();
  });

  it('leaves the live database intact when the temporary snapshot cannot be written', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cli2im-notification-store-'));
    temporaryDirectories.push(directory);
    const dbPath = join(directory, 'sessions.db');
    const store = await SessionStore.create(dbPath);
    await store.enqueueNotification(completionEvent({ eventKey: 'evt_before_temp_failure' }));
    const liveBefore = readFileSync(dbPath);

    chmodSync(directory, 0o500);
    try {
      await expect(store.enqueueNotification(
        completionEvent({ eventKey: 'evt_temp_failure' }),
      )).rejects.toThrow();
    } finally {
      chmodSync(directory, 0o700);
    }

    expect(readFileSync(dbPath)).toEqual(liveBefore);
    expect(readdirSync(directory).filter((name) => name.includes('.tmp-'))).toEqual([]);
    store.close();
  });

  it.each(['corrupt', 'missing'] as const)(
    'recovers a %s live database from the previous valid snapshot and ignores interrupted temps',
    async (failure) => {
      const directory = mkdtempSync(join(tmpdir(), 'cli2im-notification-store-'));
      temporaryDirectories.push(directory);
      const dbPath = join(directory, 'sessions.db');
      const first = completionEvent({ eventKey: `evt_${failure}_recoverable` });
      const second = completionEvent({ eventKey: `evt_${failure}_newer` });
      const store = await SessionStore.create(dbPath);
      await store.enqueueNotification(first);
      await store.enqueueNotification(second);
      store.close();
      expect(existsSync(`${dbPath}.bak`)).toBe(true);

      const interruptedTemp = join(directory, '.sessions.db.tmp-interrupted');
      writeFileSync(interruptedTemp, 'partial snapshot', { mode: 0o644 });
      if (failure === 'corrupt') {
        writeFileSync(dbPath, 'not a sqlite database', { mode: 0o644 });
      } else {
        unlinkSync(dbPath);
      }

      const recovered = await SessionStore.create(dbPath);
      expect((await recovered.listPendingNotifications()).map((row) => row.event.eventKey)).toEqual([
        first.eventKey,
      ]);
      recovered.close();

      expect(statSync(dbPath).mode & 0o777).toBe(0o600);
      expect(statSync(interruptedTemp).mode & 0o777).toBe(0o600);
      const SQL = await initSqlJs({ locateFile: (file: string) => join(sqlWasmDir, file) });
      const verified = new SQL.Database(readFileSync(dbPath)) as unknown as ReadOnlyTestDatabase;
      expect(verified.exec('SELECT COUNT(*) FROM notification_deliveries')[0]?.values[0]?.[0]).toBe(1);
      verified.close();
    },
  );
});
