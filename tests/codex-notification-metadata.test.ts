import { mkdtempSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NotificationMetadataResolver,
  sanitizeTaskTitle,
} from '../src/notifications/metadata.js';

describe('sanitizeTaskTitle', () => {
  it('removes secrets URLs home paths and instruction wrappers from a task title', () => {
    const title = sanitizeTaskTitle(`
<environment_context>ignored</environment_context>
请部署 /Users/test/private/repo token=sk-live-secret https://example.test/a?token=abc
`);
    expect(title).toBe('请部署 repo token=[REDACTED] https://example.test/a');
    expect(title).not.toContain('/Users/test');
    expect(title).not.toContain('sk-live-secret');
  });

  it('strips non-user wrappers code fences and Markdown link targets before choosing a line', () => {
    const title = sanitizeTaskTitle(`
# AGENTS.md instructions
<INSTRUCTIONS>synthetic wrapper</INSTRUCTIONS>
\`\`\`ts
const syntheticSecret = true;
\`\`\`
请阅读 [报告](https://example.test/private?token=synthetic) 并总结
`);

    expect(title).toBe('请阅读 报告 并总结');
  });

  it('redacts private-key headers named secrets and OpenAI-style keys before truncation', () => {
    const title = sanitizeTaskTitle(
      'Review -----BEGIN TEST PRIVATE KEY----- password:synthetic-password sess-abcdefghijklmnop remaining text',
    );

    expect(title).toBe('Review [REDACTED] password=[REDACTED] [REDACTED] remaining text');
  });

  it('truncates CJK-heavy and Latin-heavy titles by Unicode code points', () => {
    expect(Array.from(sanitizeTaskTitle('测'.repeat(45)))).toHaveLength(40);
    expect(Array.from(sanitizeTaskTitle('a'.repeat(90)))).toHaveLength(80);
    expect(Array.from(sanitizeTaskTitle('😀'.repeat(90)))).toHaveLength(80);
  });
});

describe('NotificationMetadataResolver', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => (
      rm(directory, { recursive: true, force: true })
    )));
  });

  function makeTemporaryDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), 'cli2im-notification-metadata-'));
    temporaryDirectories.push(directory);
    return directory;
  }

  it('resolves project and title with explicit fallbacks', async () => {
    const resolver = new NotificationMetadataResolver({
      codexDir: '/tmp/missing-codex-dir',
      resolveGitRoot: async () => null,
    });
    const result = await resolver.resolve({
      sessionId: 'abcdefgh-1234', cwd: '/missing/project', source: 'unknown', userText: '', attachmentName: undefined,
    });
    expect(result).toMatchObject({
      projectName: 'project', taskName: '未命名任务 · abcdefgh', surface: 'Codex', shortTaskId: 'abcdefgh',
    });
  });

  it('uses bounded session-index titles before user text and attachments', async () => {
    const codexDir = makeTemporaryDirectory();
    await writeFile(join(codexDir, 'session_index.jsonl'), [
      JSON.stringify({ id: 'session_1', thread_name: 'Indexed task', ignored: 'synthetic-secret' }),
      JSON.stringify({ id: 'other', thread_name: 'Other task' }),
    ].join('\n'), 'utf8');
    const resolver = new NotificationMetadataResolver({
      codexDir,
      resolveGitRoot: async () => '/workspace/repository',
    });

    const result = await resolver.resolve({
      sessionId: 'session_1',
      cwd: '/Users/test/private/repository/subdirectory',
      source: 'cli',
      userText: 'Lower-priority user text',
      attachmentName: 'lower-priority.pdf',
    });

    expect(result).toEqual({
      projectName: 'repository',
      taskName: 'Indexed task',
      surface: 'CLI',
      shortTaskId: 'session_',
    });
    expect(JSON.stringify(result)).not.toContain('/Users/test');
    expect(JSON.stringify(result)).not.toContain('synthetic-secret');
  });

  it('uses sanitized user text then a safe attachment label', async () => {
    const codexDir = makeTemporaryDirectory();
    const resolver = new NotificationMetadataResolver({ codexDir, resolveGitRoot: async () => null });

    expect(await resolver.resolve({
      sessionId: 'usertext-1234',
      cwd: '/workspace/project',
      source: 'vscode',
      userText: 'Analyze /home/test/private/report.csv api_key=synthetic-secret-value',
      attachmentName: 'ignored.pdf',
    })).toEqual({
      projectName: 'project',
      taskName: 'Analyze report.csv api_key=[REDACTED]',
      surface: 'IDE',
      shortTaskId: 'usertext',
    });

    expect(await resolver.resolve({
      sessionId: 'attachme-1234',
      cwd: '/workspace/project',
      source: 'codexbot',
      userText: '',
      attachmentName: '/Users/test/private/report.pdf',
    })).toEqual({
      projectName: 'project',
      taskName: '处理文件：report.pdf',
      surface: 'codexbot',
      shortTaskId: 'attachme',
    });
  });

  it('caches Git-root resolution per cwd and never exposes the cwd', async () => {
    const codexDir = makeTemporaryDirectory();
    const cwd = join(makeTemporaryDirectory(), 'repo', 'nested');
    await mkdir(cwd, { recursive: true });
    let calls = 0;
    const resolver = new NotificationMetadataResolver({
      codexDir,
      resolveGitRoot: async (receivedCwd) => {
        calls += 1;
        expect(receivedCwd).toBe(cwd);
        return join(cwd, '..');
      },
    });
    const input = {
      sessionId: 'cachegit-1234',
      cwd,
      source: 'desktop',
      userText: 'Task title',
      attachmentName: undefined,
    };

    const first = await resolver.resolve(input);
    const second = await resolver.resolve(input);

    expect(calls).toBe(1);
    expect(first.projectName).toBe('repo');
    expect(first.surface).toBe('Codex Desktop');
    expect(second).toEqual(first);
    expect(JSON.stringify(first)).not.toContain(cwd);
  });
});
