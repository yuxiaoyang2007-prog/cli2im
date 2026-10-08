import { constants, closeSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { stableJSON } from './policy.js';

export type VerificationStatus = 'VERIFIED' | 'LEAK' | 'UNSUPPORTED' | 'ERROR' | 'STALE' | 'UNVERIFIED';
export interface AgentBinary { realpath: string; size: number; mtime: number }
export interface VerificationRecord {
  bot: string; scopeKey: string; policyFingerprint: string; agentBinary: AgentBinary;
  status: VerificationStatus; checks: Array<{ name: string; status: string }>;
  checkedAt: string; checkOverrides?: Record<string, unknown>;
}
export function identifyBinary(binary: string, searchPath = process.env.PATH ?? ''): AgentBinary {
  const candidates = isAbsolute(binary) ? [binary] : searchPath.split(delimiter).filter(Boolean).map(root => join(root, binary));
  for (const candidate of candidates) {
    try {
      const path = realpathSync(candidate);
      const info = statSync(path);
      if (info.isFile() && (info.mode & 0o111)) return { realpath: path, size: info.size, mtime: info.mtimeMs };
    } catch { /* Try the next executable search directory. */ }
  }
  throw new Error('Isolation agent executable is unavailable');
}
function validRecord(value: unknown): value is VerificationRecord {
  const r = value as VerificationRecord;
  return !!r && typeof r.bot === 'string' && typeof r.scopeKey === 'string' && typeof r.policyFingerprint === 'string'
    && ['VERIFIED', 'LEAK', 'UNSUPPORTED', 'ERROR', 'STALE', 'UNVERIFIED'].includes(r.status)
    && typeof r.checkedAt === 'string' && Number.isFinite(Date.parse(r.checkedAt))
    && !!r.agentBinary && typeof r.agentBinary.realpath === 'string' && Number.isFinite(r.agentBinary.size) && Number.isFinite(r.agentBinary.mtime)
    && Array.isArray(r.checks) && r.checks.every(c => c && typeof c.name === 'string' && typeof c.status === 'string');
}
/** Bridge-owned atomic record store. Corruption is an error, never an empty writable store. */
export class VerificationStore {
  private listeners = new Set<(record: VerificationRecord) => void>();
  constructor(private path: string) {}
  onChange(listener: (record: VerificationRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private read(): VerificationRecord[] {
    try {
      if (!lstatSync(this.path).isFile()) throw new Error('Invalid verification file');
      const data = JSON.parse(readFileSync(this.path, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.records) || !data.records.every(validRecord)) throw new Error('Invalid verification file');
      return data.records;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error('Isolation verification records are unreadable');
    }
  }
  state(bot: string, scopeKey: string, policyFingerprint: string, agentBinary: AgentBinary): VerificationStatus {
    try {
      const r = this.read().find(r => r.bot === bot && r.scopeKey === scopeKey);
      if (!r) return 'UNVERIFIED';
      if (r.policyFingerprint !== policyFingerprint || stableJSON(r.agentBinary) !== stableJSON(agentBinary)) return 'STALE';
      return r.status;
    } catch { return 'ERROR'; }
  }
  put(record: VerificationRecord): void {
    if (!validRecord(record)) throw new Error('Invalid verification record');
    // Revoke live children even if publication of a failed check cannot complete.
    if (record.status !== 'VERIFIED') for (const listener of this.listeners) listener(record);
    const records = this.read().filter(r => r.bot !== record.bot || r.scopeKey !== record.scopeKey);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try { fchmodSync(fd, 0o600); writeFileSync(fd, JSON.stringify({ version: 1, records: [...records, record] })); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temp, this.path);
    const parent = openSync(dirname(this.path), constants.O_RDONLY);
    try { fsyncSync(parent); } finally { closeSync(parent); }
    if (record.status === 'VERIFIED') for (const listener of this.listeners) listener(record);
  }
}
