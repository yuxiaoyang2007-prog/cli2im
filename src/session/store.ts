import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'ascii');
const EXPECTED_SESSION_COLUMNS = new Set([
  'id',
  'key',
  'agent_name',
  'agent_session_id',
  'working_directory',
  'state',
  'created_at',
  'last_active_at',
]);

export class SessionStore {
  private db: Database;
  private dbPath: string;
  private privacyPublicationPending = false;

  private constructor(db: Database, dbPath: string) {
    this.db = db;
    this.dbPath = dbPath;
  }

  static async create(dbPath: string): Promise<SessionStore> {
    const SQL = await initSqlJs({
      locateFile: (file: string) => join(sqlWasmDir, file),
    });
    let db: Database;
    let openedExistingSnapshot = false;

    if (dbPath === ':memory:') {
      db = new SQL.Database();
    } else {
      hardenDatabaseSnapshotModes(dbPath);
      const mainExists = existsSync(dbPath);
      const backupPath = databaseBackupPath(dbPath);
      const backupExists = existsSync(backupPath);
      const mainSnapshot = loadDatabaseSnapshot(SQL, dbPath);
      const backupSnapshot = loadDatabaseSnapshot(SQL, backupPath);
      if (
        mainSnapshot
        && backupSnapshot
        && backupSupersedesPendingTerminalState(
          mainSnapshot.database,
          backupSnapshot.database,
        )
      ) {
        mainSnapshot.database.close();
        restoreDatabaseSnapshot(dbPath, backupSnapshot.bytes);
        db = backupSnapshot.database;
        openedExistingSnapshot = true;
      } else if (mainSnapshot) {
        backupSnapshot?.database.close();
        db = mainSnapshot.database;
        openedExistingSnapshot = true;
      } else {
        if (backupSnapshot) {
          restoreDatabaseSnapshot(dbPath, backupSnapshot.bytes);
          db = backupSnapshot.database;
          openedExistingSnapshot = true;
        } else if (mainExists || backupExists) {
          throw new Error('Session database has no valid snapshot');
        } else {
          db = new SQL.Database();
        }
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
        first_attempt_at INTEGER,
        last_attempt_at INTEGER,
        next_retry_at INTEGER,
        delivered_at INTEGER,
        delayed INTEGER,
        transport_message_id TEXT,
        acknowledged_at INTEGER,
        delayed_patch_completed_at INTEGER
      )
    `);
    const deliverySchemaMigrated = ensureNotificationDeliveryColumns(db);

    const store = new SessionStore(db, dbPath);
    if (openedExistingSnapshot) {
      compactDatabaseForPrivacy(db);
      saveDatabaseSnapshotPair(dbPath, Buffer.from(db.export()));
    } else if (cursorSchemaMigrated || deliverySchemaMigrated) {
      store.save();
    }
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
    await this.upsertNotificationCursors([cursor]);
  }

  async upsertNotificationCursors(cursors: NotificationCursor[]): Promise<void> {
    if (cursors.length === 0) return;
    this.db.run('BEGIN');
    try {
      for (const cursor of cursors) {
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
      }
      this.db.run('COMMIT');
    } catch (error) {
      this.db.run('ROLLBACK');
      throw error;
    }
    this.save();
  }

  async enqueueNotification(event: CodexNotificationEvent): Promise<boolean> {
    this.db.run(
      `INSERT OR IGNORE INTO notification_deliveries
         (event_key, event_json, status, attempts, first_attempt_at, last_attempt_at,
          next_retry_at, delivered_at, transport_message_id, acknowledged_at,
          delayed_patch_completed_at)
       VALUES (?, ?, 'pending', 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`,
      [event.eventKey, JSON.stringify(event)],
    );
    const inserted =
      (this.db as Database & { getRowsModified(): number }).getRowsModified() === 1;
    if (inserted) this.save();
    return inserted;
  }

  async listPendingNotifications(): Promise<StoredNotificationDelivery[]> {
    const stmt = this.db.prepare(
      `SELECT event_json, status, attempts, first_attempt_at, last_attempt_at,
              next_retry_at, delivered_at, transport_message_id, acknowledged_at,
              delayed_patch_completed_at
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
        firstAttemptAt: row.first_attempt_at === null
          ? null
          : (row.first_attempt_at as number),
        lastAttemptAt: row.last_attempt_at === null
          ? null
          : (row.last_attempt_at as number),
        nextRetryAt: row.next_retry_at === null ? null : (row.next_retry_at as number),
        deliveredAt: row.delivered_at === null ? null : (row.delivered_at as number),
        transportMessageId: row.transport_message_id === null
          ? null
          : (row.transport_message_id as string),
        acknowledgedAt: row.acknowledged_at === null
          ? null
          : (row.acknowledged_at as number),
        delayedPatchCompletedAt: row.delayed_patch_completed_at === null
          ? null
          : (row.delayed_patch_completed_at as number),
      });
    }
    stmt.free();
    return deliveries;
  }

  async markNotificationAttemptStarted(eventKey: string, attemptedAt: number): Promise<void> {
    this.db.run(
      `UPDATE notification_deliveries
       SET attempts = attempts + 1,
           first_attempt_at = COALESCE(first_attempt_at, ?),
           last_attempt_at = ?,
           next_retry_at = NULL
       WHERE event_key = ? AND status = 'pending'`,
      [attemptedAt, attemptedAt, eventKey],
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

  async recordNotificationReceipt(
    eventKey: string,
    messageId: string,
    acknowledgedAt: number,
  ): Promise<void> {
    this.db.run(
      `UPDATE notification_deliveries
       SET transport_message_id = COALESCE(transport_message_id, ?),
           acknowledged_at = COALESCE(acknowledged_at, ?),
           next_retry_at = NULL
       WHERE event_key = ? AND status = 'pending'`,
      [messageId, acknowledgedAt, eventKey],
    );
    this.save();
  }

  async markNotificationDelayedPatchCompleted(
    eventKey: string,
    completedAt: number,
  ): Promise<void> {
    this.db.run(
      `UPDATE notification_deliveries
       SET delayed_patch_completed_at = COALESCE(delayed_patch_completed_at, ?),
           next_retry_at = NULL
       WHERE event_key = ? AND status = 'pending'`,
      [completedAt, eventKey],
    );
    this.save();
  }

  async markNotificationDelivered(eventKey: string, deliveredAt: number): Promise<void> {
    if (this.dbPath !== ':memory:') this.privacyPublicationPending = true;
    this.db.run('PRAGMA secure_delete = ON');
    this.db.run(
      `UPDATE notification_deliveries
       SET event_json = '{}',
           status = 'delivered',
           attempts = 0,
           first_attempt_at = NULL,
           last_attempt_at = NULL,
           next_retry_at = NULL,
           delivered_at = ?,
           delayed = NULL,
           transport_message_id = NULL,
           acknowledged_at = NULL,
           delayed_patch_completed_at = NULL
       WHERE event_key = ? AND status = 'pending'`,
      [deliveredAt, eventKey],
    );
    this.db.run('VACUUM');
    this.saveTerminalSnapshot();
  }

  async markNotificationFailed(
    eventKey: string,
    status: 'failed' | 'discarded' = 'failed',
  ): Promise<void> {
    if (this.dbPath !== ':memory:') this.privacyPublicationPending = true;
    this.db.run('PRAGMA secure_delete = ON');
    this.db.run(
      `UPDATE notification_deliveries
       SET event_json = '{}',
           status = ?,
           attempts = 0,
           first_attempt_at = NULL,
           last_attempt_at = NULL,
           next_retry_at = NULL,
           delivered_at = NULL,
           delayed = NULL,
           transport_message_id = NULL,
           acknowledged_at = NULL,
           delayed_patch_completed_at = NULL
       WHERE event_key = ? AND status = 'pending'`,
      [status, eventKey],
    );
    this.db.run('VACUUM');
    this.saveTerminalSnapshot();
  }

  save(): void {
    if (this.dbPath === ':memory:') return;
    const data = this.db.export();
    if (this.privacyPublicationPending) {
      saveDatabaseSnapshotPair(this.dbPath, Buffer.from(data));
      this.privacyPublicationPending = false;
    } else {
      saveDatabaseSnapshot(this.dbPath, Buffer.from(data));
    }
  }

  private saveTerminalSnapshot(): void {
    this.save();
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

function databaseBackupPath(dbPath: string): string {
  return `${dbPath}.bak`;
}

function hardenDatabaseSnapshotModes(dbPath: string): void {
  const directory = dirname(dbPath);
  if (!existsSync(directory)) return;
  const name = basename(dbPath);
  const snapshotNames = new Set([name, `${name}.bak`]);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const isOwnedTemp = entry.name.startsWith(`.${name}.tmp-`)
      || entry.name.startsWith(`.${name}.bak.tmp-`)
      || entry.name.startsWith(`.${name}.restore.tmp-`);
    if (entry.isFile() && (snapshotNames.has(entry.name) || isOwnedTemp)) {
      chmodSync(join(directory, entry.name), 0o600);
    }
  }
}

function loadDatabaseSnapshot(
  SQL: SqlJsStatic,
  path: string,
): { database: Database; bytes: Buffer } | null {
  if (!existsSync(path)) return null;
  chmodSync(path, 0o600);
  const bytes = readFileSync(path);
  if (bytes.length < 100 || !bytes.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER)) {
    return null;
  }
  let database: Database | undefined;
  try {
    database = new SQL.Database(bytes);
    if (!hasValidIntegrity(database) || !hasExpectedSessionsSchema(database)) {
      database.close();
      return null;
    }
    return { database, bytes };
  } catch {
    database?.close();
    return null;
  }
}

function saveDatabaseSnapshot(
  dbPath: string,
  data: Buffer,
): void {
  const directory = dirname(dbPath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const token = `${process.pid}-${randomUUID()}`;
  const liveTemp = join(directory, `.${basename(dbPath)}.tmp-${token}`);
  const backupTemp = join(directory, `.${basename(dbPath)}.bak.tmp-${token}`);

  try {
    writeDurableFile(liveTemp, data);
    if (existsSync(dbPath)) {
      if (existsSync(dbPath)) chmodSync(dbPath, 0o600);
      writeDurableFile(backupTemp, readFileSync(dbPath));
      renameSync(backupTemp, databaseBackupPath(dbPath));
      chmodSync(databaseBackupPath(dbPath), 0o600);
      fsyncDirectory(directory);
    }
    renameSync(liveTemp, dbPath);
    chmodSync(dbPath, 0o600);
    fsyncDirectory(directory);
  } finally {
    rmSync(liveTemp, { force: true });
    rmSync(backupTemp, { force: true });
  }
}

function saveDatabaseSnapshotPair(dbPath: string, data: Buffer): void {
  const directory = dirname(dbPath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const token = `${process.pid}-${randomUUID()}`;
  const liveTemp = join(directory, `.${basename(dbPath)}.tmp-${token}`);
  const backupTemp = join(directory, `.${basename(dbPath)}.bak.tmp-${token}`);

  try {
    writeDurableFile(liveTemp, data);
    writeDurableFile(backupTemp, data);
    renameSync(backupTemp, databaseBackupPath(dbPath));
    chmodSync(databaseBackupPath(dbPath), 0o600);
    fsyncDirectory(directory);
    renameSync(liveTemp, dbPath);
    chmodSync(dbPath, 0o600);
    fsyncDirectory(directory);
  } finally {
    rmSync(liveTemp, { force: true });
    rmSync(backupTemp, { force: true });
  }
}

function restoreDatabaseSnapshot(dbPath: string, data: Buffer): void {
  const directory = dirname(dbPath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temp = join(directory, `.${basename(dbPath)}.restore.tmp-${process.pid}-${randomUUID()}`);
  try {
    writeDurableFile(temp, data);
    renameSync(temp, dbPath);
    chmodSync(dbPath, 0o600);
    fsyncDirectory(directory);
  } finally {
    rmSync(temp, { force: true });
  }
}

function writeDurableFile(path: string, data: Buffer): void {
  const descriptor = openSync(path, 'wx', 0o600);
  try {
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, data);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function fsyncDirectory(directory: string): void {
  const descriptor = openSync(directory, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function compactDatabaseForPrivacy(db: Database): void {
  db.run('PRAGMA secure_delete = ON');
  db.run('VACUUM');
}

function hasValidIntegrity(db: Database): boolean {
  const stmt = db.prepare('PRAGMA integrity_check');
  const hasRow = stmt.step();
  const result = hasRow ? Object.values(stmt.getAsObject())[0] : undefined;
  const valid = result === 'ok' && !stmt.step();
  stmt.free();
  return valid;
}

function hasExpectedSessionsSchema(db: Database): boolean {
  const stmt = db.prepare('PRAGMA table_info(sessions)');
  const names = new Set<unknown>();
  while (stmt.step()) names.add(stmt.getAsObject().name);
  stmt.free();
  return names.size === EXPECTED_SESSION_COLUMNS.size
    && [...EXPECTED_SESSION_COLUMNS].every((name) => names.has(name));
}

function backupSupersedesPendingTerminalState(main: Database, backup: Database): boolean {
  const mainStatuses = readDeliveryStatuses(main);
  const backupStatuses = readDeliveryStatuses(backup);
  if (!mainStatuses || !backupStatuses) return false;
  for (const [eventKey, current] of mainStatuses) {
    const recovered = backupStatuses.get(eventKey);
    if (
      current.status === 'pending'
      && recovered?.eventJson === '{}'
      && ['delivered', 'failed', 'discarded'].includes(recovered.status)
    ) {
      return true;
    }
  }
  return false;
}

function readDeliveryStatuses(
  db: Database,
): Map<string, { eventJson: string; status: string }> | null {
  try {
    const stmt = db.prepare(
      'SELECT event_key, event_json, status FROM notification_deliveries',
    );
    const statuses = new Map<string, { eventJson: string; status: string }>();
    while (stmt.step()) {
      const row = stmt.getAsObject();
      if (
        typeof row.event_key === 'string'
        && typeof row.event_json === 'string'
        && typeof row.status === 'string'
      ) {
        statuses.set(row.event_key, {
          eventJson: row.event_json,
          status: row.status,
        });
      }
    }
    stmt.free();
    return statuses;
  } catch {
    return null;
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
  if (!columns.has('first_attempt_at')) {
    db.run('ALTER TABLE notification_deliveries ADD COLUMN first_attempt_at INTEGER');
    migrated = true;
  }
  if (!columns.has('transport_message_id')) {
    db.run('ALTER TABLE notification_deliveries ADD COLUMN transport_message_id TEXT');
    migrated = true;
  }
  if (!columns.has('acknowledged_at')) {
    db.run('ALTER TABLE notification_deliveries ADD COLUMN acknowledged_at INTEGER');
    migrated = true;
  }
  if (!columns.has('delayed_patch_completed_at')) {
    db.run('ALTER TABLE notification_deliveries ADD COLUMN delayed_patch_completed_at INTEGER');
    migrated = true;
  }
  return migrated;
}
