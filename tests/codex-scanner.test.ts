import { mkdir, rm, writeFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexSessionScanner } from '../src/session/codex-scanner.js';

describe('CodexSessionScanner', () => {
  let dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    dirs = [];
  });

  async function makeCodexDir(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'cli2im-codex-'));
    dirs.push(dir);
    return dir;
  }

  it('parses session_index.jsonl and returns sessions sorted by updated_at desc', async () => {
    const codexDir = await makeCodexDir();
    const lines = [
      JSON.stringify({ id: 'aaa-111', thread_name: 'Old session', updated_at: '2026-03-07T07:15:01.972Z' }),
      JSON.stringify({ id: 'bbb-222', thread_name: 'New session', updated_at: '2026-05-08T12:00:00.000Z' }),
      JSON.stringify({ id: 'ccc-333', thread_name: 'Mid session', updated_at: '2026-04-01T00:00:00.000Z' }),
    ];
    await writeFile(join(codexDir, 'session_index.jsonl'), lines.join('\n') + '\n', 'utf8');

    const sessions = await new CodexSessionScanner(codexDir).scan();

    expect(sessions).toHaveLength(3);
    expect(sessions[0].sessionId).toBe('bbb-222');
    expect(sessions[0].title).toBe('New session');
    expect(sessions[0].status).toBe('historical');
    expect(sessions[1].sessionId).toBe('ccc-333');
    expect(sessions[2].sessionId).toBe('aaa-111');
  });

  it('respects the limit option', async () => {
    const codexDir = await makeCodexDir();
    const lines = Array.from({ length: 20 }, (_, i) =>
      JSON.stringify({ id: `id-${i}`, thread_name: `Session ${i}`, updated_at: `2026-05-${String(i + 1).padStart(2, '0')}T00:00:00Z` }),
    );
    await writeFile(join(codexDir, 'session_index.jsonl'), lines.join('\n') + '\n', 'utf8');

    const sessions = await new CodexSessionScanner(codexDir).scan({ limit: 5 });
    expect(sessions).toHaveLength(5);
  });

  it('returns empty array when session_index.jsonl does not exist', async () => {
    const codexDir = await makeCodexDir();
    const sessions = await new CodexSessionScanner(codexDir).scan();
    expect(sessions).toEqual([]);
  });

  it('skips malformed lines gracefully', async () => {
    const codexDir = await makeCodexDir();
    const content = [
      'not-json',
      JSON.stringify({ id: 'valid-id', thread_name: 'Valid', updated_at: '2026-05-01T00:00:00Z' }),
      JSON.stringify({ no_id: true }),
      '',
    ].join('\n');
    await writeFile(join(codexDir, 'session_index.jsonl'), content, 'utf8');

    const sessions = await new CodexSessionScanner(codexDir).scan();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe('valid-id');
  });

  it('uses sessionId prefix as fallback title', async () => {
    const codexDir = await makeCodexDir();
    await writeFile(
      join(codexDir, 'session_index.jsonl'),
      JSON.stringify({ id: 'abcdefgh-1234', updated_at: '2026-01-01T00:00:00Z' }) + '\n',
      'utf8',
    );

    const sessions = await new CodexSessionScanner(codexDir).scan();
    expect(sessions[0].title).toBe('abcdefgh');
  });

  it('handles a 10MB session index by reading only bounded head and tail windows', async () => {
    const codexDir = await makeCodexDir();
    const head = JSON.stringify({
      id: 'head-session',
      thread_name: 'Head Session',
      updated_at: '2026-05-01T00:00:00Z',
    }) + '\n';
    const tail = '\n' + JSON.stringify({
      id: 'tail-session',
      thread_name: 'Tail Session',
      updated_at: '2026-05-09T00:00:00Z',
    }) + '\n';
    const padding = 'x'.repeat(10 * 1024 * 1024 - head.length - tail.length);
    await writeFile(join(codexDir, 'session_index.jsonl'), head + padding + tail, 'utf8');

    const sessions = await new CodexSessionScanner(codexDir).scan({ limit: 10 });

    expect(sessions.map((session) => session.sessionId)).toEqual([
      'tail-session',
      'head-session',
    ]);
  });
});
