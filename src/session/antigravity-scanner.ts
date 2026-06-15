import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { CLISession, CLISessionStatus } from './cli-scanner.js';
import { readHeadTailWindow } from './file-window.js';

interface AntigravityRecord {
  type?: string;
  content?: unknown;
}

const DEFAULT_LIMIT = 15;

// Antigravity (`agy`) stores one directory per conversation under
//   <antigravityDir>/brain/<conversationId>/.system_generated/logs/transcript.jsonl
// Each transcript begins with the user's first turn, whose content is wrapped in
// <USER_REQUEST>...</USER_REQUEST>. Unlike the Gemini CLI, antigravity does NOT
// persist a per-conversation working directory anywhere readable (it spawns with
// the bot's cwd but never writes it back), so this scanner cannot offer a
// cwdFilter — it lists antigravity conversations only, which is the whole point:
// it must NOT fall back to the Gemini CLI's ~/.gemini/tmp store.
export class AntigravitySessionScanner {
  constructor(private readonly antigravityDir: string) {}

  async scan(opts: { limit?: number } = {}): Promise<CLISession[]> {
    const limit = opts.limit ?? DEFAULT_LIMIT;
    const brainDir = join(this.antigravityDir, 'brain');

    let conversationIds: string[];
    try {
      conversationIds = (await readdir(brainDir, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return [];
    }

    const sessions: CLISession[] = [];

    await Promise.all(conversationIds.map(async (conversationId) => {
      const transcriptPath = join(
        brainDir,
        conversationId,
        '.system_generated',
        'logs',
        'transcript.jsonl',
      );
      try {
        const session = await this.parseTranscript(transcriptPath, conversationId);
        if (session) sessions.push(session);
      } catch {
        // skip corrupted / missing transcript
      }
    }));

    sessions.sort((a, b) => b.lastModified - a.lastModified);
    return sessions.slice(0, limit);
  }

  private async parseTranscript(filePath: string, conversationId: string): Promise<CLISession | null> {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile() || fileStat.size === 0) return null;

    const raw = await readHeadTailWindow(filePath);
    const lines = raw.split('\n').filter((l) => l.trim());
    if (lines.length === 0) return null;

    const title = extractFirstUserRequest(lines) || conversationId.slice(0, 8);

    return {
      sessionId: conversationId,
      cwd: '',
      title,
      lastModified: fileStat.mtimeMs,
      status: 'historical' as CLISessionStatus,
      fileSize: fileStat.size,
    };
  }
}

function extractFirstUserRequest(lines: string[]): string {
  for (const line of lines) {
    let rec: AntigravityRecord;
    try {
      rec = JSON.parse(line) as AntigravityRecord;
    } catch {
      continue;
    }
    if (typeof rec.content !== 'string') continue;

    const match = rec.content.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
    if (!match) continue;

    const text = match[1]
      .replace(/^<cti-sender[^>]*\/>\s*/s, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) return text.slice(0, 120);
  }
  return '';
}
