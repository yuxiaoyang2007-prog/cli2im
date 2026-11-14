import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { CLISession, CLISessionStatus } from './cli-scanner.js';
import { readHeadTailWindow } from './file-window.js';

interface AntigravityRecord {
  type?: string;
  content?: unknown;
}

interface TranscriptCandidate {
  conversationId: string;
  transcriptPath: string;
  mtimeMs: number;
  size: number;
}

const DEFAULT_LIMIT = 15;
const STAT_CONCURRENCY = 32;

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
    if (limit <= 0) return [];
    const brainDir = join(this.antigravityDir, 'brain');

    let conversationIds: string[];
    try {
      conversationIds = (await readdir(brainDir, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return [];
    }

    const candidates: TranscriptCandidate[] = [];
    let cursor = 0;
    const workerCount = Math.min(STAT_CONCURRENCY, conversationIds.length);

    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (cursor < conversationIds.length) {
          const conversationId = conversationIds[cursor++]!;
          const transcriptPath = join(
            brainDir,
            conversationId,
            '.system_generated',
            'logs',
            'transcript.jsonl',
          );
          try {
            const fileStat = await stat(transcriptPath);
            if (fileStat.isFile() && fileStat.size > 0) {
              candidates.push({
                conversationId,
                transcriptPath,
                mtimeMs: fileStat.mtimeMs,
                size: fileStat.size,
              });
            }
          } catch {
            // skip missing / inaccessible transcript
          }
        }
      }),
    );

    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

    const sessions: CLISession[] = [];
    for (const candidate of candidates) {
      if (sessions.length >= limit) break;
      try {
        const session = await this.parseCandidate(candidate);
        if (session) sessions.push(session);
      } catch {
        // skip corrupted transcript
      }
    }

    return sessions;
  }

  private async parseCandidate(candidate: TranscriptCandidate): Promise<CLISession | null> {
    const raw = await readHeadTailWindow(candidate.transcriptPath);
    const lines = raw.split('\n').filter((l) => l.trim());
    if (lines.length === 0) return null;

    const title = extractFirstUserRequest(lines) || candidate.conversationId.slice(0, 8);

    return {
      sessionId: candidate.conversationId,
      cwd: '',
      title,
      lastModified: candidate.mtimeMs,
      status: 'historical' as CLISessionStatus,
      fileSize: candidate.size,
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
