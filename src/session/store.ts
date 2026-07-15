import initSqlJs, { type Database } from 'sql.js';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import type { Session, SessionKey } from '../types.js';
import type {
  CodexNotificationEvent,
  NotificationBinding,
  NotificationCursor,
  StoredNotificationDelivery,
} from '../notifications/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const sqlWasmDir = dirname(require.resolve('sql.js/dist/sql-wasm.wasm'));

export class SessionStore {
  private db: Database;
  private dbPath: string;

  private constructor(db: Database, dbPath: string) {
    this.db = db;
    this.dbPath = dbPath;
  }

  static async create(dbPath: string): Promise<SessionStore> {
    const SQL = await initSqlJs({
      locateFile: (file: string) => join(sqlWasmDir, file),
    });
    let db: Database;

    if (dbPath === ':memory:') {
      db = new SQL.Database();
    } else {
      if (existsSync(dbPath)) {
        const buffer = readFileSync(dbPath);
        db = new SQL.Database(buffer);
      } else {
        db = new SQL.Database();
      }
    }

    db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
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

    db.run(`
      CREATE TABLE IF NOT EXISTS notification_bindings (
        bot_name TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS notification_cursors (
        file_path TEXT PRIMARY KEY,
        file_id TEXT NOT NULL,
        byte_offset INTEGER NOT NULL,
        continuity_hash TEXT,
        updated_at INTEGER NOT NULL
      )
    `);
    const cursorSchemaMigrated = ensureNotificationCursorContinuityColumn(db);

    db.run(`
      CREATE TABLE IF NOT EXISTS notification_deliveries (
        event_key TEXT PRIMARY KEY,
        event_json TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        last_attempt_at INTEGER,
        next_retry_at INTEGER,
        delivered_at INTEGER,
        delayed INTEGER
      )
    `);
    const deliverySchemaMigrated = ensureNotificationDeliveryColumns(db);

    const store = new SessionStore(db, dbPath);
    if (cursorSchemaMigrated || deliverySchemaMigrated) store.save();
    return store;
  }

  async getOrCreate(key: SessionKey, defaults: {
    agentName: string;
    workingDirectory: string;
  }): Promise<Session> {
    const existing = await this.getByKey(key);
    if (existing) return existing;
    return this.create({ key, ...defaults });
  }

  async create(opts: {
    key: SessionKey;
    agentName: string;
    workingDirectory: string;
  }): Promise<Session> {
    const now = Date.now();
    const id = randomUUID();

    this.db.run(
      'INSERT INTO sessions (id, key, agent_name, working_directory, state, created_at, last_active_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, opts.key, opts.agentName, opts.workingDirectory, 'active', now, now],
    );

    return {
      id,
      key: opts.key,
      agentName: opts.agentName,
      workingDirectory: opts.workingDirectory,
      state: 'active',
      createdAt: now,
      lastActiveAt: now,
    };
  }

  async getByKey(key: SessionKey): Promise<Session | null> {
    const stmt = this.db.prepare('SELECT * FROM sessions WHERE key = ?');
    stmt.bind([key]);

    if (!stmt.step()) {
      stmt.free();
      return null;
    }

    const row = stmt.getAsObject();
    stmt.free();
    return this.rowToSession(row);
  }

  async getById(id: string): Promise<Session | null> {
    const stmt = this.db.prepare('SELECT * FROM sessions WHERE id = ?');
    stmt.bind([id]);

    if (!stmt.step()) {
      stmt.free();
      return null;
    }

    const row = stmt.getAsObject();
    stmt.free();
    return this.rowToSession(row);
  }

  async touch(id: string): Promise<void> {
    this.db.run('UPDATE sessions SET last_active_at = ? WHERE id = ?', [Date.now(), id]);
  }

  async updateAgentSessionId(id: string, agentSessionId: string): Promise<void> {
    this.db.run('UPDATE sessions SET agent_session_id = ? WHERE id = ?', [agentSessionId, id]);
  }

  async updateState(id: string, state: Session['state']): Promise<void> {
    this.db.run('UPDATE sessions SET state = ? WHERE id = ?', [state, id]);
  }

  async updateWorkingDirectory(id: string, dir: string): Promise<void> {
    this.db.run('UPDATE sessions SET working_directory = ? WHERE id = ?', [dir, id]);
  }

  async findIdle(maxIdleMs: number): Promise<Session[]> {
    const cutoff = Date.now() - maxIdleMs;
    const stmt = this.db.prepare(
      "SELECT * FROM sessions WHERE last_active_at <= ? AND state = 'active'",
    );
    stmt.bind([cutoff]);

    const sessions: Session[] = [];
    while (stmt.step()) {
      sessions.push(this.rowToSession(stmt.getAsObject()));
    }
    stmt.free();
    return sessions;
  }

  async listByBot(botName: string): Promise<Session[]> {
    const pattern = `%:${botName}`;
    const stmt = this.db.prepare('SELECT * FROM sessions WHERE key LIKE ?');
    stmt.bind([pattern]);

    const sessions: Session[] = [];
    while (stmt.step()) {
      sessions.push(this.rowToSession(stmt.getAsObject()));
    }
    stmt.free();
    return sessions;
  }

  async delete(id: string): Promise<void> {
    this.db.run('DELETE FROM sessions WHERE id = ?', [id]);
  }

  async bindNotificationTarget(binding: NotificationBinding): Promise<void> {
    this.db.run(
      `INSERT INTO notification_bindings (bot_name, platform, chat_id, user_id, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(bot_name) DO UPDATE SET
         platform = excluded.platform,
         chat_id = excluded.chat_id,
         user_id = excluded.user_id,
         updated_at = excluded.updated_at`,
      [
        binding.botName,
        binding.platform,
        binding.chatId,
        binding.userId,
        binding.updatedAt,
      ],
    );
    this.save();
  }

  async getNotificationBinding(botName: string): Promise<NotificationBinding | null> {
    const stmt = this.db.prepare(
      'SELECT bot_name, platform, chat_id, user_id, updated_at FROM notification_bindings WHERE bot_name = ?',
    );
    stmt.bind([botName]);

    if (!stmt.step()) {
      stmt.free();
      return null;
    }

    const row = stmt.getAsObject();
    stmt.free();
    return {
      botName: row.bot_name as string,
      platform: row.platform as NotificationBinding['platform'],
      chatId: row.chat_id as string,
      userId: row.user_id as string,
      updatedAt: row.updated_at as number,
    };
  }

  async getNotificationCursor(filePath: string): Promise<NotificationCursor | null> {
    const stmt = this.db.prepare(
      `SELECT file_path, file_id, byte_offset, continuity_hash, updated_at
       FROM notification_cursors WHERE file_path = ?`,
    );
    stmt.bind([filePath]);

    if (!stmt.step()) {
      stmt.free();
      return null;
    }

    const row = stmt.getAsObject();
    stmt.free();
    return {
      filePath: row.file_path as string,
      fileId: row.file_id as string,
      byteOffset: row.byte_offset as number,
      ...(typeof row.continuity_hash === 'string'
        ? { continuityHash: row.continuity_hash }
        : {}),
      updatedAt: row.updated_at as number,
    };
  }

  async upsertNotificationCursor(cursor: NotificationCursor): Promise<void> {
    this.db.run(
      `INSERT INTO notification_cursors
         (file_path, file_id, byte_offset, continuity_hash, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(file_path) DO UPDATE SET
         file_id = excluded.file_id,
         byte_offset = excluded.byte_offset,
         continuity_hash = excluded.continuity_hash,
         updated_at = excluded.updated_at`,
      [
        cursor.filePath,
        cursor.fileId,
        cursor.byteOffset,
        cursor.continuityHash ?? null,
        cursor.updatedAt,
      ],
    );
    this.save();
  }

  async enqueueNotification(
    event: CodexNotificationEvent,
    delayed?: boolean,
  ): Promise<boolean> {
    this.db.run(
      `INSERT OR IGNORE INTO notification_deliveries
         (event_key, event_json, status, attempts, last_attempt_at,
          next_retry_at, delivered_at, delayed)
       VALUES (?, ?, 'pending', 0, NULL, NULL, NULL, ?)`,
      [event.eventKey, JSON.stringify(event), delayed === undefined ? null : Number(delayed)],
    );
    const inserted =
      (this.db as Database & { getRowsModified(): number }).getRowsModified() === 1;
    if (inserted) this.save();
    return inserted;
  }

  async listPendingNotifications(): Promise<StoredNotificationDelivery[]> {
    const stmt = this.db.prepare(
      `SELECT event_json, status, attempts, last_attempt_at, next_retry_at,
              delivered_at, delayed
       FROM notification_deliveries
       WHERE status = 'pending'
       ORDER BY rowid`,
    );
    const deliveries: StoredNotificationDelivery[] = [];

    while (stmt.step()) {
      const row = stmt.getAsObject();
      deliveries.push({
        event: JSON.parse(row.event_json as string) as CodexNotificationEvent,
        status: row.status as StoredNotificationDelivery['status'],
        attempts: row.attempts as number,
        lastAttemptAt: row.last_attempt_at === null
          ? null
          : (row.last_attempt_at as number),
        nextRetryAt: row.next_retry_at === null ? null : (row.next_retry_at as number),
        deliveredAt: row.delivered_at === null ? null : (row.delivered_at as number),
        delayed: row.delayed === 1 ? true : row.delayed === 0 ? false : null,
      });
    }
    stmt.free();
    return deliveries;
  }

  async markNotificationAttemptStarted(eventKey: string, attemptedAt: number): Promise<void> {
    this.db.run(
      `UPDATE notification_deliveries
       SET attempts = attempts + 1, last_attempt_at = ?, next_retry_at = NULL
       WHERE event_key = ? AND status = 'pending'`,
      [attemptedAt, eventKey],
    );
    this.save();
  }

  async setNotificationNextRetry(eventKey: string, nextRetryAt: number | null): Promise<void> {
    this.db.run(
      `UPDATE notification_deliveries
       SET next_retry_at = ?
       WHERE event_key = ? AND status = 'pending'`,
      [nextRetryAt, eventKey],
    );
    this.save();
  }

  async setNotificationDelayed(eventKey: string, delayed: boolean): Promise<void> {
    this.db.run(
      `UPDATE notification_deliveries
       SET delayed = COALESCE(delayed, ?)
       WHERE event_key = ? AND status = 'pending'`,
      [Number(delayed), eventKey],
    );
    this.save();
  }

  async markNotificationDelivered(eventKey: string, deliveredAt: number): Promise<void> {
    this.db.run(
      `UPDATE notification_deliveries
       SET event_json = '{}', status = 'delivered', next_retry_at = NULL, delivered_at = ?
       WHERE event_key = ? AND status = 'pending'`,
      [deliveredAt, eventKey],
    );
    this.save();
  }

  async markNotificationFailed(
    eventKey: string,
    status: 'failed' | 'discarded' = 'failed',
  ): Promise<void> {
    this.db.run(
      `UPDATE notification_deliveries
       SET status = ?, next_retry_at = NULL
       WHERE event_key = ? AND status = 'pending'`,
      [status, eventKey],
    );
    this.save();
  }

  save(): void {
    if (this.dbPath === ':memory:') return;
    mkdirSync(dirname(this.dbPath), { recursive: true });
    const data = this.db.export();
    writeFileSync(this.dbPath, Buffer.from(data));
  }

  close(): void {
    this.db.close();
  }

  private rowToSession(row: Record<string, unknown>): Session {
    return {
      id: row.id as string,
      key: row.key as SessionKey,
      agentName: row.agent_name as string,
      agentSessionId: (row.agent_session_id as string) || undefined,
      workingDirectory: row.working_directory as string,
      state: row.state as Session['state'],
      createdAt: row.created_at as number,
      lastActiveAt: row.last_active_at as number,
    };
  }
}

function ensureNotificationCursorContinuityColumn(db: Database): boolean {
  const stmt = db.prepare('PRAGMA table_info(notification_cursors)');
  let found = false;
  while (stmt.step()) {
    if (stmt.getAsObject().name === 'continuity_hash') {
      found = true;
      break;
    }
  }
  stmt.free();
  if (found) return false;
  db.run('ALTER TABLE notification_cursors ADD COLUMN continuity_hash TEXT');
  return true;
}

function ensureNotificationDeliveryColumns(db: Database): boolean {
  const stmt = db.prepare('PRAGMA table_info(notification_deliveries)');
  const columns = new Set<string>();
  while (stmt.step()) {
    const name = stmt.getAsObject().name;
    if (typeof name === 'string') columns.add(name);
  }
  stmt.free();

  let migrated = false;
  if (!columns.has('last_attempt_at')) {
    db.run('ALTER TABLE notification_deliveries ADD COLUMN last_attempt_at INTEGER');
    migrated = true;
  }
  if (!columns.has('delayed')) {
    db.run('ALTER TABLE notification_deliveries ADD COLUMN delayed INTEGER');
    migrated = true;
  }
  return migrated;
}
