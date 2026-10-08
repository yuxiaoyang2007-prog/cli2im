import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

export interface MemoryHistory { text: string; at: string; by: string }
export interface MemoryEntry {
  id: number; text: string; createdAt: string; updatedAt: string; createdBy: string; history: MemoryHistory[];
}
export interface MemoryDocument {
  version: 1; principal: string; generation: number; nextId: number; entries: MemoryEntry[];
}

export class MemoryError extends Error {}
/** Mutation passed validation/authorization, but its write was not confirmed durable. */
export class MemoryWriteError extends Error {}

/** One writer per principal in this process, including separate store instances. */
export class MemoryStore {
  private static pending = new Map<string, Promise<unknown>>();
  constructor(readonly directory: string) {}

  filePath(principal: string): string {
    return join(this.directory, `${createHash('sha256').update(principal).digest('hex').slice(0, 32)}.json`);
  }

  private async serial<T>(principal: string, action: () => Promise<T>): Promise<T> {
    const key = resolve(this.filePath(principal));
    const previous = MemoryStore.pending.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(action);
    MemoryStore.pending.set(key, operation);
    try { return await operation; }
    finally { if (MemoryStore.pending.get(key) === operation) MemoryStore.pending.delete(key); }
  }

  read(principal: string): Promise<MemoryDocument> {
    return this.serial(principal, () => this.load(principal));
  }

  async generation(principal: string): Promise<number> { return (await this.read(principal)).generation; }

  add(principal: string, actor: string, text: string): Promise<MemoryEntry> {
    return this.change(principal, document => {
      validateText(text);
      if (document.entries.length >= 200) throw new MemoryError('每个记忆范围最多保存 200 条');
      const now = new Date().toISOString();
      const entry: MemoryEntry = { id: document.nextId++, text, createdAt: now, updatedAt: now, createdBy: actor, history: [] };
      document.entries.push(entry);
      return entry;
    });
  }

  edit(principal: string, actor: string, id: number, text: string, authorize: (entry: MemoryEntry) => boolean): Promise<void> {
    return this.change(principal, document => {
      validateText(text);
      const entry = this.entry(document, id, authorize);
      const now = new Date().toISOString();
      entry.history.push({ text: entry.text, at: now, by: actor });
      entry.history = entry.history.slice(-20);
      entry.text = text;
      entry.updatedAt = now;
    });
  }

  forget(principal: string, id: number, authorize: (entry: MemoryEntry) => boolean): Promise<number> {
    return this.change(principal, document => {
      this.entry(document, id, authorize);
      document.entries = document.entries.filter(entry => entry.id !== id);
      return ++document.generation;
    });
  }

  private entry(document: MemoryDocument, id: number, authorize: (entry: MemoryEntry) => boolean): MemoryEntry {
    const entry = document.entries.find(entry => entry.id === id);
    if (!entry) throw new MemoryError('未找到该记忆条目');
    if (!authorize(entry)) throw new MemoryError('只有创建者或该机器人的管理员可以修改或忘记群记忆');
    return entry;
  }

  private change<T>(principal: string, mutate: (document: MemoryDocument) => T): Promise<T> {
    return this.serial(principal, async () => {
      const document = await this.load(principal);
      const result = mutate(document);
      let temp: string | undefined;
      let created = false;
      try {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        await chmod(this.directory, 0o700);
        // Runs under the principal lock, including across store instances.
        const prefix = `${basename(this.filePath(principal))}.tmp-`;
        for (const name of await readdir(this.directory)) {
          if (name.startsWith(prefix) && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(name.slice(prefix.length))) {
            await unlink(join(this.directory, name));
          }
        }
        temp = `${this.filePath(principal)}.tmp-${randomUUID()}`;
        const file = await open(temp, 'wx', 0o600);
        created = true;
        try {
          await file.writeFile(JSON.stringify(document));
          await file.sync();
        } finally { await file.close(); }
        await rename(temp, this.filePath(principal));
        created = false;
        const directory = await open(this.directory, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      } catch {
        throw new MemoryWriteError('记忆写入结果未确认');
      } finally {
        if (created && temp) {
          try { await unlink(temp); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new MemoryWriteError('记忆写入结果未确认');
          }
        }
      }
      return result;
    });
  }

  private async load(principal: string): Promise<MemoryDocument> {
    let text: string;
    try { text = await readFile(this.filePath(principal), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, principal, generation: 0, nextId: 1, entries: [] };
      }
      throw error;
    }
    try {
      const doc = JSON.parse(text) as MemoryDocument;
      if (!doc || doc.version !== 1 || doc.principal !== principal || !integer(doc.generation, 0)
        || !integer(doc.nextId, 1) || !Array.isArray(doc.entries) || doc.entries.length > 200) throw new Error();
      const ids = new Set<number>();
      for (const entry of doc.entries) {
        if (!entry || !integer(entry.id, 1) || entry.id >= doc.nextId || ids.has(entry.id)
          || !validText(entry.text) || !date(entry.createdAt) || !date(entry.updatedAt)
          || typeof entry.createdBy !== 'string' || !entry.createdBy
          || !Array.isArray(entry.history) || entry.history.length > 20
          || entry.history.some(version => !version || !validText(version.text) || !date(version.at)
            || typeof version.by !== 'string' || !version.by)) throw new Error();
        ids.add(entry.id);
      }
      return doc;
    } catch { throw new MemoryError('记忆文件损坏，已拒绝读写；请管理员检查备份'); }
  }
}

function integer(value: unknown, minimum: number): boolean { return Number.isSafeInteger(value) && Number(value) >= minimum; }
function date(value: unknown): boolean { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function validText(value: unknown): value is string { return typeof value === 'string' && !!value.trim() && value.length <= 2000; }
function validateText(value: string): void {
  if (!validText(value)) throw new MemoryError('记忆文本不能为空，且不能超过 2000 字符');
}
