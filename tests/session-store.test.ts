import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionStore } from '../src/session/store.js';
import type { SessionKey } from '../src/types.js';

const THIS_FILE = fileURLToPath(import.meta.url);

describe('SessionStore', () => {
  let store: SessionStore;

  beforeEach(async () => {
    store = await SessionStore.create(':memory:');
  });

  it('creates a session', async () => {
    const key: SessionKey = 'feishu:oc_abc:ccbot';
    const session = await store.create({
      key,
      agentName: 'claude-code',
      workingDirectory: '~/projects',
    });
    expect(session.id).toBeDefined();
    expect(session.key).toBe(key);
    expect(session.agentName).toBe('claude-code');
    expect(session.state).toBe('active');
  });

  it('retrieves session by key', async () => {
    const key: SessionKey = 'feishu:oc_abc:ccbot';
    await store.create({ key, agentName: 'claude-code', workingDirectory: '~/projects' });
    const found = await store.getByKey(key);
    expect(found).not.toBeNull();
    expect(found!.key).toBe(key);
  });

  it('returns null for missing key', async () => {
    const found = await store.getByKey('feishu:oc_missing:bot');
    expect(found).toBeNull();
  });

  it('updates lastActiveAt on touch', async () => {
    const key: SessionKey = 'feishu:oc_abc:ccbot';
    const session = await store.create({ key, agentName: 'claude-code', workingDirectory: '~' });
    const before = session.lastActiveAt;

    await new Promise((r) => setTimeout(r, 50));
    await store.touch(session.id);

    const updated = await store.getByKey(key);
    expect(updated!.lastActiveAt).toBeGreaterThan(before);
  });

  it('updates agentSessionId', async () => {
    const key: SessionKey = 'feishu:oc_abc:ccbot';
    const session = await store.create({ key, agentName: 'claude-code', workingDirectory: '~' });
    await store.updateAgentSessionId(session.id, 'ses_abc123');

    const updated = await store.getByKey(key);
    expect(updated!.agentSessionId).toBe('ses_abc123');
  });

  it('finds idle sessions', async () => {
    const key: SessionKey = 'feishu:oc_abc:ccbot';
    await store.create({ key, agentName: 'claude-code', workingDirectory: '~' });

    // With maxIdleMs=0, everything is "idle"
    const idle = await store.findIdle(0);
    expect(idle.length).toBe(1);

    // With huge maxIdleMs, nothing is idle
    const notIdle = await store.findIdle(999999999);
    expect(notIdle.length).toBe(0);
  });

  it('updates state', async () => {
    const key: SessionKey = 'feishu:oc_abc:ccbot';
    const session = await store.create({ key, agentName: 'claude-code', workingDirectory: '~' });
    await store.updateState(session.id, 'handed_off');

    const updated = await store.getByKey(key);
    expect(updated!.state).toBe('handed_off');
  });

  it('deletes session', async () => {
    const key: SessionKey = 'feishu:oc_abc:ccbot';
    const session = await store.create({ key, agentName: 'claude-code', workingDirectory: '~' });
    await store.delete(session.id);

    const found = await store.getByKey(key);
    expect(found).toBeNull();
  });

  it('lists sessions by botName', async () => {
    await store.create({ key: 'feishu:oc_1:ccbot', agentName: 'claude-code', workingDirectory: '~' });
    await store.create({ key: 'feishu:oc_2:ccbot', agentName: 'claude-code', workingDirectory: '~' });
    await store.create({ key: 'feishu:oc_3:other', agentName: 'codex', workingDirectory: '~' });

    const ccbotSessions = await store.listByBot('ccbot');
    expect(ccbotSessions.length).toBe(2);
  });

  it('prunes stale cursors, old terminal deliveries, and old terminal tasks while keeping active rows', async () => {
    const now = 1_800_000_000_000;
    const dayMs = 24 * 3600_000;
    await store.create({ key: 'feishu:oc_keep:ccbot', agentName: 'claude-code', workingDirectory: '~' });

    // 1 stale cursor by age, 1 missing-file cursor (recent), 1 valid cursor on existing path
    await store.upsertNotificationCursor({
      filePath: '/tmp/nonexistent-old.jsonl',
      fileId: '1:1',
      byteOffset: 100,
      updatedAt: now - 20 * dayMs,
    });
    await store.upsertNotificationCursor({
      filePath: '/tmp/nonexistent-missing.jsonl',
      fileId: '1:2',
      byteOffset: 50,
      updatedAt: now - 1000,
    });
    await store.upsertNotificationCursor({
      filePath: THIS_FILE,
      fileId: '1:3',
      byteOffset: 20,
      updatedAt: now - 1000,
    });

    // Deliveries: old delivered (pruned), recent delivered (kept), pending (kept)
    const db = (store as unknown as { db: { run: (sql: string, params?: unknown[]) => void; prepare: (sql: string) => { step: () => boolean; getAsObject: () => Record<string, unknown>; free: () => void } } }).db;
    db.run(
      `INSERT INTO notification_deliveries (event_key, event_json, status, attempts, delivered_at)
       VALUES (?, '{}', 'delivered', 0, ?)`,
      ['ev-old', now - 20 * dayMs],
    );
    db.run(
      `INSERT INTO notification_deliveries (event_key, event_json, status, attempts, delivered_at)
       VALUES (?, '{}', 'delivered', 0, ?)`,
      ['ev-recent', now - 2 * dayMs],
    );
    db.run(
      `INSERT INTO notification_deliveries (event_key, event_json, status, attempts, first_attempt_at)
       VALUES (?, '{"a":1}', 'pending', 1, ?)`,
      ['ev-pending', now - 25 * dayMs],
    );

    // Tasks: old COMPLETED (pruned), old RUNNING (kept!), recent COMPLETED (kept)
    db.run(
      `INSERT INTO notification_tasks (task_id, session_id, first_turn_id, current_turn_id, project_name, task_name, state, created_at, updated_at)
       VALUES ('t-old-done', 's1', 'turn1', 'turn1', 'p', 'n', 'COMPLETED', ?, ?)`,
      [now - 40 * dayMs, now - 40 * dayMs],
    );
    db.run(
      `INSERT INTO notification_tasks (task_id, session_id, first_turn_id, current_turn_id, project_name, task_name, state, created_at, updated_at)
       VALUES ('t-old-running', 's2', 'turn1', 'turn1', 'p', 'n', 'RUNNING', ?, ?)`,
      [now - 40 * dayMs, now - 40 * dayMs],
    );
    db.run(
      `INSERT INTO notification_tasks (task_id, session_id, first_turn_id, current_turn_id, project_name, task_name, state, created_at, updated_at)
       VALUES ('t-recent-done', 's3', 'turn1', 'turn1', 'p', 'n', 'COMPLETED', ?, ?)`,
      [now - 5 * dayMs, now - 5 * dayMs],
    );

    const result = store.pruneStaleRecords({ now, pruneMissingCursorFiles: true });
    expect(result).toEqual({
      deletedCursors: 2,
      deletedDeliveries: 1,
      deletedTasks: 1,
    });

    expect((await store.getByKey('feishu:oc_keep:ccbot'))).not.toBeNull();
    expect(await store.getNotificationCursor(THIS_FILE)).not.toBeNull();
    expect(await store.getNotificationCursor('/tmp/nonexistent-old.jsonl')).toBeNull();

    const remainingDeliv: string[] = [];
    const delivStmt = db.prepare('SELECT event_key FROM notification_deliveries ORDER BY event_key');
    while (delivStmt.step()) remainingDeliv.push(String(delivStmt.getAsObject().event_key));
    delivStmt.free();
    expect(remainingDeliv).toEqual(['ev-pending', 'ev-recent']);

    const remainingTasks: string[] = [];
    const taskStmt = db.prepare('SELECT task_id FROM notification_tasks ORDER BY task_id');
    while (taskStmt.step()) remainingTasks.push(String(taskStmt.getAsObject().task_id));
    taskStmt.free();
    expect(remainingTasks).toEqual(['t-old-running', 't-recent-done']);
  });

  it('coalesces non-privacy saves when coalesceMs > 0 and flushes on close', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli2im-coalesce-'));
    const dbPath = join(dir, 'state.db');
    const store = await SessionStore.create(dbPath, { coalesceMs: 120 });
    await store.getOrCreate('feishu:chat1:bot1', {
      agentName: 'agy',
      workingDirectory: dir,
    });
    await store.updatePreferences('feishu:chat1:bot1', { effort: 'high' });
    await store.updatePreferences('feishu:chat1:bot1', { model: 'gemini-4-argon-high' });

    // Before close, no forced sync flush has necessarily landed; close flushes pending timer.
    store.close();

    const reopened = await SessionStore.create(dbPath);
    expect(await reopened.getPreferences('feishu:chat1:bot1')).toMatchObject({
      effort: 'high',
      model: 'gemini-4-argon-high',
    });
    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
