import { mkdir, rm, writeFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GeminiSessionScanner } from '../src/session/gemini-scanner.js';

describe('GeminiSessionScanner', () => {
  let dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    dirs = [];
  });

  async function makeGeminiDir(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'cli2im-gemini-'));
    dirs.push(dir);
    await mkdir(join(dir, 'tmp', 'project-1', 'chats'), { recursive: true });
    await writeFile(
      join(dir, 'projects.json'),
      JSON.stringify({ projects: { '/Users/test/project': 'project-1' } }),
      'utf8',
    );
    return dir;
  }

  async function writeGeminiSession(
    geminiDir: string,
    projectDir: string,
    sessionId: string,
    prompt: string,
  ): Promise<void> {
    await mkdir(join(geminiDir, 'tmp', projectDir, 'chats'), { recursive: true });
    await writeFile(
      join(geminiDir, 'tmp', projectDir, 'chats', `session-${sessionId}.jsonl`),
      [
        JSON.stringify({ sessionId }),
        JSON.stringify({ type: 'user', content: prompt }),
      ].join('\n') + '\n',
      'utf8',
    );
  }

  it('handles a 10MB session file by reading only bounded head and tail windows', async () => {
    const geminiDir = await makeGeminiDir();
    const sessionPath = join(geminiDir, 'tmp', 'project-1', 'chats', 'session-big.jsonl');
    const header = JSON.stringify({
      sessionId: 'gemini-session-1',
      lastUpdated: '2026-05-09T00:00:00Z',
    }) + '\n';
    const userMessage = '\n' + JSON.stringify({
      type: 'user',
      content: 'Tail prompt from large session',
    }) + '\n';
    const padding = 'x'.repeat(10 * 1024 * 1024 - header.length - userMessage.length);
    await writeFile(sessionPath, header + padding + userMessage, 'utf8');

    const sessions = await new GeminiSessionScanner(geminiDir).scan({ limit: 10 });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      sessionId: 'gemini-session-1',
      cwd: '/Users/test/project',
      title: 'Tail prompt from large session',
      status: 'historical',
    });
  });

  it('uses only capped project-registry metadata reads for large JSON files', async () => {
    const geminiDir = await makeGeminiDir();
    const registry = JSON.stringify({ projects: { '/Users/test/huge-project': 'project-1' } });
    const paddedHead = registry + ' '.repeat(32 * 1024 - registry.length);
    await writeFile(join(geminiDir, 'projects.json'), paddedHead + 'x'.repeat(1024 * 1024), 'utf8');

    const sessionPath = join(geminiDir, 'tmp', 'project-1', 'chats', 'session-huge-registry.jsonl');
    await writeFile(
      sessionPath,
      [
        JSON.stringify({ sessionId: 'gemini-session-2' }),
        JSON.stringify({ type: 'user', content: 'Prompt from capped registry test' }),
      ].join('\n') + '\n',
      'utf8',
    );

    const sessions = await new GeminiSessionScanner(geminiDir).scan({ limit: 10 });

    expect(sessions[0]).toMatchObject({
      sessionId: 'gemini-session-2',
      cwd: '/Users/test/huge-project',
      title: 'Prompt from capped registry test',
    });
  });

  it('filters sessions to the resolved matching cwd when cwdFilter is set', async () => {
    const geminiDir = mkdtempSync(join(tmpdir(), 'cli2im-gemini-'));
    const ownProject = mkdtempSync(join(tmpdir(), 'cli2im-gemini-own-'));
    const otherProject = mkdtempSync(join(tmpdir(), 'cli2im-gemini-other-'));
    dirs.push(geminiDir, ownProject, otherProject);
    await writeFile(
      join(geminiDir, 'projects.json'),
      JSON.stringify({
        projects: {
          [ownProject]: 'project-own',
          [otherProject]: 'project-other',
        },
      }),
      'utf8',
    );
    await writeGeminiSession(geminiDir, 'project-own', 'own', 'Own prompt');
    await writeGeminiSession(geminiDir, 'project-other', 'other', 'Other prompt');

    const scanner = new GeminiSessionScanner(geminiDir);

    await expect(scanner.scan({ limit: 10 })).resolves.toHaveLength(2);
    await expect(scanner.scan({ limit: 10, cwdFilter: ownProject })).resolves.toMatchObject([
      {
        sessionId: 'own',
        cwd: ownProject,
        title: 'Own prompt',
      },
    ]);
  });

  it('returns no sessions when cwdFilter cannot be resolved', async () => {
    const geminiDir = await makeGeminiDir();
    await writeGeminiSession(geminiDir, 'project-1', 'unresolved-filter', 'Prompt');

    const sessions = await new GeminiSessionScanner(geminiDir).scan({
      limit: 10,
      cwdFilter: join(geminiDir, 'does-not-exist'),
    });

    expect(sessions).toEqual([]);
  });
});
