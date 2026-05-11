import { join } from 'node:path';
import type { CLISession } from './cli-scanner.js';
import { readHeadTailWindow } from './file-window.js';

interface CodexSessionIndexEntry {
  id?: unknown;
  thread_name?: unknown;
  updated_at?: unknown;
}

const DEFAULT_LIMIT = 15;

export class CodexSessionScanner {
  constructor(private readonly codexDir: string) {}

  async scan(opts: { limit?: number } = {}): Promise<CLISession[]> {
    const limit = opts.limit ?? DEFAULT_LIMIT;
    const indexPath = join(this.codexDir, 'session_index.jsonl');

    let content: string;
    try {
      content = await readHeadTailWindow(indexPath);
    } catch {
      return [];
    }

    const entries: Array<{ id: string; title: string; updatedAt: number }> = [];

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const raw = JSON.parse(line) as CodexSessionIndexEntry;
        const id = asString(raw.id);
        if (!id) continue;

        const title = asString(raw.thread_name) ?? id.slice(0, 8);
        const updatedAt = parseTimestamp(raw.updated_at);

        entries.push({ id, title, updatedAt });
      } catch {
        // Skip malformed lines.
      }
    }

    entries.sort((a, b) => b.updatedAt - a.updatedAt);

    return entries.slice(0, limit).map((entry) => ({
      sessionId: entry.id,
      cwd: '',
      title: entry.title,
      lastModified: entry.updatedAt,
      status: 'historical' as const,
    }));
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseTimestamp(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? 0 : ms;
  }
  return 0;
}
