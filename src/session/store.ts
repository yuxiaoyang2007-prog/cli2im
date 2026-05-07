import initSqlJs, { type Database } from 'sql.js';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import type { Session, SessionKey } from '../types.js';

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

    return new SessionStore(db, dbPath);
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
