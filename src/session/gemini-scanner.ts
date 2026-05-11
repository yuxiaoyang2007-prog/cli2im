import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { CLISession, CLISessionStatus } from './cli-scanner.js';
import { readCappedTextFile, readHeadTailWindow } from './file-window.js';

interface GeminiSessionHeader {
  sessionId?: string;
  startTime?: string;
  lastUpdated?: string;
}

interface GeminiMessageRecord {
  type?: string;
  content?: unknown;
}

const DEFAULT_LIMIT = 15;

export class GeminiSessionScanner {
  constructor(private readonly geminiDir: string) {}

  async scan(opts: { limit?: number } = {}): Promise<CLISession[]> {
    const limit = opts.limit ?? DEFAULT_LIMIT;
    const tmpDir = join(this.geminiDir, 'tmp');

    const pathMap = await this.loadProjectRegistry();

    let projectDirs: string[];
    try {
      projectDirs = (await readdir(tmpDir, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return [];
    }

    const allSessions: CLISession[] = [];

    await Promise.all(projectDirs.map(async (projectDir) => {
      const chatsDir = join(tmpDir, projectDir, 'chats');
      let files: string[];
      try {
        files = (await readdir(chatsDir)).filter((f) => f.startsWith('session-') && f.endsWith('.jsonl'));
      } catch {
        return;
      }

      const cwd = pathMap.get(projectDir) ?? projectDir;

      await Promise.all(files.map(async (file) => {
        const filePath = join(chatsDir, file);
        try {
          const session = await this.parseSessionFile(filePath, cwd);
          if (session) allSessions.push(session);
        } catch {
          // skip corrupted
        }
      }));
    }));

    allSessions.sort((a, b) => b.lastModified - a.lastModified);
    return allSessions.slice(0, limit);
  }

  private async loadProjectRegistry(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    try {
      const raw = await readCappedTextFile(join(this.geminiDir, 'projects.json'));
      const data = JSON.parse(raw) as { projects?: Record<string, string> };
      if (data.projects) {
        for (const [path, id] of Object.entries(data.projects)) {
          map.set(id, path);
        }
      }
    } catch {
      // no registry
    }
    return map;
  }

  private async parseSessionFile(filePath: string, cwd: string): Promise<CLISession | null> {
    const fileStat = await stat(filePath);
    const raw = await readHeadTailWindow(filePath);
    const lines = raw.split('\n').filter((l) => l.trim());
    if (lines.length === 0) return null;

    let header: GeminiSessionHeader;
    try {
      header = JSON.parse(lines[0]) as GeminiSessionHeader;
    } catch {
      return null;
    }

    if (!header.sessionId) return null;

    const hasMessage = lines.some((l) => {
      try {
        const rec = JSON.parse(l) as GeminiMessageRecord;
        return rec.type === 'user' || rec.type === 'gemini';
      } catch {
        return false;
      }
    });
    if (!hasMessage) return null;

    const firstPrompt = this.extractFirstUserMessage(lines);

    const lastUpdated = header.lastUpdated
      ? new Date(header.lastUpdated).getTime()
      : fileStat.mtimeMs;

    return {
      sessionId: header.sessionId,
      cwd,
      title: firstPrompt || header.sessionId.slice(0, 8),
      lastModified: Number.isFinite(lastUpdated) ? lastUpdated : fileStat.mtimeMs,
      status: 'historical' as CLISessionStatus,
      fileSize: fileStat.size,
    };
  }

  private extractFirstUserMessage(lines: string[]): string {
    for (const line of lines) {
      try {
        const rec = JSON.parse(line) as GeminiMessageRecord;
        if (rec.type === 'user') {
          let text = '';
          if (Array.isArray(rec.content)) {
            const block = rec.content.find((c: Record<string, unknown>) => typeof c.text === 'string');
            if (block) text = (block as { text: string }).text;
          } else if (typeof rec.content === 'string') {
            text = rec.content;
          }
          if (text) {
            text = text.replace(/^<cti-sender[^>]*\/>\s*/s, '').trim();
            if (text) return text.slice(0, 120);
          }
        }
      } catch {
        continue;
      }
    }
    return '';
  }
}
