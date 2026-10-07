import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_INCOMING_ENTRIES = 10_000;
const INCOMING_TTL_MS = 24 * 60 * 60 * 1000;
const locks = new Map<string, Promise<unknown>>();

export interface RecoveredResult {
  version: 1;
  savedAt: number;
  status: 'completed' | 'error';
  text: string;
  truncated: boolean;
  delivery: 'manual';
}

interface IncomingLedger {
  version: 1;
  entries: Array<[string, number]>;
}

export interface RecoveryStoreOptions {
  now?: () => number;
  incomingTtlMs?: number;
  incomingLimit?: number;
}

/** Private local recovery only. Nothing is rerun or resent automatically. */
export class RecoveryStore {
  private root: string;
  private now: () => number;
  private ttl: number;
  private limit: number;

  constructor(root: string, options: RecoveryStoreOptions = {}) {
    this.root = resolve(root);
    this.now = options.now ?? Date.now;
    this.ttl = Math.max(1, Math.min(INCOMING_TTL_MS, options.incomingTtlMs ?? INCOMING_TTL_MS));
    this.limit = Math.max(1, Math.min(MAX_INCOMING_ENTRIES, options.incomingLimit ?? MAX_INCOMING_ENTRIES));
  }

  /** Caller must supply the full authorized user/chat/thread/bot scope. */
  async save(scopeKey: string, result: { status: 'completed' | 'error'; text: string }): Promise<RecoveredResult> {
    const file = this.resultPath(scopeKey);
    return serialized(file, async () => {
      await this.ensureRoot();
      const bytes = Buffer.from(result.text, 'utf8');
      const truncated = bytes.length > MAX_RESULT_BYTES;
      let end = Math.min(bytes.length, MAX_RESULT_BYTES);
      // Avoid storing a replacement character for an incomplete UTF-8 sequence.
      if (truncated) while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
      const saved: RecoveredResult = { version: 1, savedAt: this.now(), status: result.status, text: bytes.subarray(0, end).toString('utf8'), truncated, delivery: 'manual' };
      await this.writeJson(file, saved);
      return saved;
    });
  }

  /** Read never changes the delivery state; the user explicitly asks to resend. */
  async read(scopeKey: string): Promise<RecoveredResult | null> {
    const file = this.resultPath(scopeKey);
    return serialized(file, async () => {
      await this.ensureRoot();
      const parsed = await this.readJson(file, MAX_RESULT_BYTES * 6 + 4096);
      if (parsed === null) return null;
      if (!isRecoveredResult(parsed)) throw new Error('Recovery result is invalid');
      return { version: 1, savedAt: parsed.savedAt, status: parsed.status, text: parsed.text, truncated: parsed.truncated, delivery: 'manual' };
    });
  }

  /** False means already accepted; only a hash and timestamp are retained. */
  async acceptIncoming(platform: string, bot: string, messageId: string): Promise<boolean> {
    if (!messageId) return true; // Platforms without stable IDs cannot be deduplicated.
    const file = join(this.root, 'incoming.json');
    return serialized(file, async () => {
      await this.ensureRoot();
      const parsed = await this.readJson(file, 2 * 1024 * 1024);
      if (parsed !== null && !isIncomingLedger(parsed)) throw new Error('Incoming recovery ledger is invalid');
      const now = this.now();
      const entries = new Map<string, number>((parsed?.entries ?? []).filter(([, time]) => now - time < this.ttl));
      const key = digest(JSON.stringify([platform, bot, messageId]));
      if (entries.has(key)) return false;
      entries.set(key, now);
      const retained = [...entries].reverse().sort((a, b) => b[1] - a[1]).slice(0, this.limit);
      await this.writeJson(file, { version: 1, entries: retained } satisfies IncomingLedger);
      return true;
    });
  }

  private resultPath(scopeKey: string): string {
    if (!scopeKey) throw new Error('Recovery scope is required');
    return join(this.root, `${digest(scopeKey)}.json`);
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Recovery directory must be a real directory');
    if ((stat.mode & 0o777) !== 0o700) await chmod(this.root, 0o700);
  }

  private async readJson(file: string, maxBytes: number): Promise<unknown | null> {
    let handle;
    try {
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > maxBytes) throw new Error('Recovery file is invalid or too large');
      return JSON.parse(await handle.readFile('utf8')) as unknown;
    } finally {
      await handle.close();
    }
  }

  private async writeJson(file: string, value: unknown): Promise<void> {
    const temp = join(this.root, `.recovery-${randomUUID()}.tmp`);
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(value), 'utf8');
      await handle.sync();
      await handle.close();
      await rename(temp, file);
    } catch (error) {
      await handle.close().catch(() => {});
      // Only the temporary file created by this operation is removed.
      await unlink(temp).catch(() => {});
      throw error;
    }
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isRecoveredResult(value: unknown): value is RecoveredResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  return result.version === 1 && Number.isFinite(result.savedAt)
    && (result.status === 'completed' || result.status === 'error')
    && typeof result.text === 'string' && Buffer.byteLength(result.text, 'utf8') <= MAX_RESULT_BYTES
    && typeof result.truncated === 'boolean' && result.delivery === 'manual';
}

function isIncomingLedger(value: unknown): value is IncomingLedger {
  if (!value || typeof value !== 'object') return false;
  const ledger = value as Record<string, unknown>;
  return ledger.version === 1 && Array.isArray(ledger.entries) && ledger.entries.length <= MAX_INCOMING_ENTRIES
    && ledger.entries.every((entry: unknown) => Array.isArray(entry) && entry.length === 2
      && typeof entry[0] === 'string' && /^[a-f0-9]{64}$/.test(entry[0]) && Number.isFinite(entry[1]));
}

async function serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  locks.set(key, next);
  try {
    return await next;
  } finally {
    if (locks.get(key) === next) locks.delete(key);
  }
}
