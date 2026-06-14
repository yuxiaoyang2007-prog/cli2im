import { mkdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CLISessionScanner } from '../src/session/cli-scanner.js';

describe('CLISessionScanner', () => {
  let dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    dirs = [];
  });

  async function makeClaudeDir(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'cli2im-claude-'));
    dirs.push(dir);
    await mkdir(join(dir, 'sessions'), { recursive: true });
    await mkdir(join(dir, 'projects', 'test-project'), { recursive: true });
    return dir;
  }

  async function writeJson(path: string, value: unknown): Promise<void> {
    await writeFile(path, JSON.stringify(value), 'utf8');
  }

  async function writeJsonl(path: string, lines: unknown[]): Promise<void> {
    await writeFile(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  }

  it('scans JSONL files, merges with active sessions, filters desktop, sorts by mtime', async () => {
    const claudeDir = await makeClaudeDir();
    const livePid = process.pid;
    const stalePid = 99999999;
    const projectDir = join(claudeDir, 'projects', 'test-project');
    const baseTime = Date.now() / 1000;

    // Active session files
    await writeJson(join(claudeDir, 'sessions', `${livePid}.json`), {
      sessionId: 'session-live',
      cwd: '/projects/live',
      entrypoint: 'cli',
      name: 'My Live Session',
    });
    await writeJson(join(claudeDir, 'sessions', `${stalePid}.json`), {
      sessionId: 'session-stale',
      cwd: '/projects/stale',
      status: 'busy',
      entrypoint: 'task',
    });
    await writeJson(join(claudeDir, 'sessions', '12345.json'), {
      sessionId: 'session-desktop',
      cwd: '/Desktop',
      entrypoint: 'claude-desktop-3p',
    });

    // JSONL files (primary data source)
    const livePath = join(projectDir, 'session-live.jsonl');
    await writeJsonl(livePath, [
      { type: 'user', message: { content: 'first msg' }, cwd: '/projects/live', gitBranch: 'main' },
      { type: 'ai-title', aiTitle: 'AI Generated Title' },
      { type: 'last-prompt', lastPrompt: 'last user message' },
    ]);
    await utimes(livePath, baseTime + 2, baseTime + 2);

    const stalePath = join(projectDir, 'session-stale.jsonl');
    await writeJsonl(stalePath, [
      { type: 'user', message: { content: 'stale first msg' }, cwd: '/projects/stale' },
      { type: 'ai-title', aiTitle: 'Stale Task' },
    ]);
    await utimes(stalePath, baseTime + 1, baseTime + 1);

    const histPath = join(projectDir, 'session-hist.jsonl');
    await writeJsonl(histPath, [
      { type: 'user', message: { content: 'old prompt' }, cwd: '/projects/old', gitBranch: 'feat' },
      { type: 'ai-title', aiTitle: 'Historical Work' },
    ]);
    await utimes(histPath, baseTime + 3, baseTime + 3);

    // Desktop session JSONL should be filtered out
    const desktopPath = join(projectDir, 'session-desktop.jsonl');
    await writeJsonl(desktopPath, [
      { type: 'user', message: { content: 'desktop' }, cwd: '/Desktop' },
    ]);
    await utimes(desktopPath, baseTime + 10, baseTime + 10);

    const sessions = await new CLISessionScanner(claudeDir).scan({ limit: 10 });

    // Desktop filtered, 3 remaining sorted by mtime desc
    expect(sessions.map((s) => s.sessionId)).toEqual([
      'session-hist',
      'session-live',
      'session-stale',
    ]);

    // Live session uses active name over aiTitle
    expect(sessions[1].title).toBe('My Live Session');
    expect(sessions[1].status).toBe('idle');
    expect(sessions[1].pid).toBe(livePid);

    // Stale session detected
    expect(sessions[2].status).toBe('stale');
    expect(sessions[2].title).toBe('Stale Task');

    // Historical session
    expect(sessions[0].status).toBe('historical');
    expect(sessions[0].title).toBe('Historical Work');
    expect(sessions[0].gitBranch).toBe('feat');
  });

  it('uses title fallback priority: customTitle > aiTitle > lastPrompt > firstUserMessage > sessionId', async () => {
    const claudeDir = await makeClaudeDir();
    const projectDir = join(claudeDir, 'projects', 'test-project');
    const baseTime = Date.now() / 1000;

    // Session with all title types
    const fullPath = join(projectDir, 'full-titles.jsonl');
    await writeJsonl(fullPath, [
      { type: 'user', message: { content: 'first msg' } },
      { type: 'ai-title', aiTitle: 'AI Title' },
      { type: 'last-prompt', lastPrompt: 'last msg' },
      { type: 'custom-title', customTitle: 'Custom Title' },
    ]);
    await utimes(fullPath, baseTime + 3, baseTime + 3);

    // Session with only aiTitle
    const aiPath = join(projectDir, 'ai-only.jsonl');
    await writeJsonl(aiPath, [
      { type: 'user', message: { content: 'first msg' } },
      { type: 'ai-title', aiTitle: 'AI Only Title' },
    ]);
    await utimes(aiPath, baseTime + 2, baseTime + 2);

    // Session with only first user message
    const firstPath = join(projectDir, 'first-only.jsonl');
    await writeJsonl(firstPath, [
      { type: 'user', message: { content: 'Only first message' } },
    ]);
    await utimes(firstPath, baseTime + 1, baseTime + 1);

    const sessions = await new CLISessionScanner(claudeDir).scan();

    expect(sessions[0].title).toBe('Custom Title');
    expect(sessions[1].title).toBe('AI Only Title');
    expect(sessions[2].title).toBe('Only first message');
  });

  it('returns an empty list when Claude directories are missing', async () => {
    const claudeDir = mkdtempSync(join(tmpdir(), 'cli2im-claude-missing-'));
    dirs.push(claudeDir);

    await expect(new CLISessionScanner(claudeDir).scan()).resolves.toEqual([]);
    await expect(stat(claudeDir)).resolves.toBeDefined();
  });

  it('uses only capped active-session metadata reads for large JSON files', async () => {
    const claudeDir = await makeClaudeDir();
    const projectDir = join(claudeDir, 'projects', 'test-project');
    const sessionPath = join(projectDir, 'session-huge-active.jsonl');
    await writeJsonl(sessionPath, [
      { type: 'user', message: { content: 'first msg' }, cwd: '/projects/from-jsonl' },
      { type: 'ai-title', aiTitle: 'Historical Title' },
    ]);

    const metadata = JSON.stringify({
      sessionId: 'session-huge-active',
      cwd: '/Users/test/active-cwd',
      entrypoint: 'cli',
      name: 'Huge Active Session',
    });
    const paddedHead = metadata + ' '.repeat(32 * 1024 - metadata.length);
    await writeFile(join(claudeDir, 'sessions', `${process.pid}.json`), paddedHead + 'x'.repeat(1024 * 1024), 'utf8');

    const sessions = await new CLISessionScanner(claudeDir).scan({ limit: 10 });

    expect(sessions[0]).toMatchObject({
      sessionId: 'session-huge-active',
      cwd: '/Users/test/active-cwd',
      title: 'Huge Active Session',
      status: 'idle',
    });
  });

  it('filters sessions by cwd before applying the limit and compares realpaths', async () => {
    const claudeDir = await makeClaudeDir();
    const projectDir = join(claudeDir, 'projects', 'test-project');
    const wantedReal = mkdtempSync(join(tmpdir(), 'cli2im-wanted-real-'));
    const wantedLink = join(tmpdir(), `cli2im-wanted-link-${Date.now()}`);
    const otherDir = mkdtempSync(join(tmpdir(), 'cli2im-other-'));
    dirs.push(wantedReal, wantedLink, otherDir);
    await symlink(wantedReal, wantedLink);
    const baseTime = Date.now() / 1000;

    const otherPath = join(projectDir, 'session-other.jsonl');
    await writeJsonl(otherPath, [
      { type: 'user', message: { content: 'new but wrong cwd' }, cwd: otherDir },
    ]);
    await utimes(otherPath, baseTime + 3, baseTime + 3);

    const wantedPath = join(projectDir, 'session-wanted.jsonl');
    await writeJsonl(wantedPath, [
      { type: 'user', message: { content: 'older but matching cwd' }, cwd: wantedReal },
    ]);
    await utimes(wantedPath, baseTime + 2, baseTime + 2);

    const sessions = await new CLISessionScanner(claudeDir).scan({
      limit: 1,
      cwdFilter: wantedLink,
    });

    expect(sessions.map((s) => s.sessionId)).toEqual(['session-wanted']);
    expect(sessions[0].cwd).toBe(wantedReal);
  });
});
