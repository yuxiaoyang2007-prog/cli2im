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

  it('keeps only basenames from absolute POSIX paths', () => {
    const title = sanitizeTaskTitle(
      '请检查 /tmp/private/run.log 和 /var/log/service/app.log 后继续',
    );

    expect(title).toBe('请检查 run.log 和 app.log 后继续');
    expect(title).not.toContain('/tmp/private');
    expect(title).not.toContain('/var/log/service');
  });

  it.each([
    ['file triple-slash URI', 'Open file:///Users/test/private/report.csv', 'Open report.csv'],
    ['file single-slash URI', 'Open file:/Users/test/private/report.csv', 'Open report.csv'],
    ['VS Code file URI', 'Open vscode://file/Users/test/private/report.csv', 'Open report.csv'],
  ])('removes directories from a %s', (_kind, value, expected) => {
    const title = sanitizeTaskTitle(value);
    expect(title).toBe(expected);
    expect(title).not.toContain('/Users/test/private');
  });

  it('keeps an HTTP URL only after removing its query and fragment', () => {
    expect(sanitizeTaskTitle(
      'Open https://example.test/private/report.csv?token=synthetic#section',
    )).toBe('Open https://example.test/private/report.csv');
  });

  it.each([
    'Analyze /tmp/private folder/report.csv and summarize',
    'Analyze /tmp/private with spaces/report.csv',
  ])('rejects an ambiguous unquoted absolute path containing spaces', (value) => {
    expect(sanitizeTaskTitle(value)).toBe('');
  });

  it('consumes complete quoted named-secret values including spaces', () => {
    const title = sanitizeTaskTitle(
      'Rotate password="alpha beta" and token=\'gamma delta\' now',
    );

    expect(title).toBe('Rotate password=[REDACTED] and token=[REDACTED] now');
    expect(title).not.toContain('alpha beta');
    expect(title).not.toContain('gamma delta');
  });

  it('consumes balanced quoted secrets containing escaped quote characters', () => {
    const title = sanitizeTaskTitle(String.raw`Rotate password="alpha \"beta\" gamma" and token='delta \'echo\' zeta' now`);

    expect(title).toBe('Rotate password=[REDACTED] and token=[REDACTED] now');
    expect(title).not.toContain('beta');
    expect(title).not.toContain('echo');
  });

  it('consumes unclosed quoted secrets through the end of the candidate', () => {
    expect(sanitizeTaskTitle('Rotate password="alpha beta credential suffix')).toBe(
      'Rotate password=[REDACTED]',
    );
    expect(sanitizeTaskTitle("Rotate token='gamma delta credential suffix")).toBe(
      'Rotate token=[REDACTED]',
    );
  });

  it.each([
    ['shell command', 'echo "deploy" && rm -rf /tmp/private'],
    ['unfenced code', 'const secretValue = process.env.SYNTHETIC_TOKEN;'],
    ['unfenced assignment', 'result = await runTask();'],
    ['unfenced JSON', '{"command":"synthetic","ok":true}'],
    ['diff', 'diff --git a/src/old.ts b/src/new.ts'],
    ['log line', '[2026-07-15T12:00:00.000Z] ERROR synthetic failure'],
    ['lowercase command', 'brew install package'],
    ['lowercase CLI command', 'gh pr view 1'],
    ['SQL', 'SELECT * FROM users;'],
    ['control-flow code', 'if (ready) deploy();'],
    ['error line', 'Error: failed'],
    ['stack line', 'at deploy (/tmp/private/app.js:10:2)'],
    ['shell redirection', 'deploy > /tmp/private/output.log'],
    ['shell operator expression', 'build && deploy'],
  ])('rejects a task title that is principally a %s', (_kind, value) => {
    expect(sanitizeTaskTitle(value)).toBe('');
  });

  it('keeps natural-language requests that mention technical commands', () => {
    expect(sanitizeTaskTitle('请运行 npm test 并总结失败原因')).toBe('请运行 npm test 并总结失败原因');
    expect(sanitizeTaskTitle('Please review the git diff and explain the change')).toBe(
      'Please review the git diff and explain the change',
    );
    expect(sanitizeTaskTitle('Go review the deployment flow')).toBe('Go review the deployment flow');
    expect(sanitizeTaskTitle('Make the release safer')).toBe('Make the release safer');
    expect(sanitizeTaskTitle('Find the notification bug')).toBe('Find the notification bug');
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

  it('falls through unsafe technical titles to the next safe source or fallback', async () => {
    const codexDir = makeTemporaryDirectory();
    await writeFile(join(codexDir, 'session_index.jsonl'), JSON.stringify({
      id: 'unsafe-index',
      thread_name: 'diff --git a/private.ts b/private.ts',
    }), 'utf8');
    const resolver = new NotificationMetadataResolver({ codexDir, resolveGitRoot: async () => null });

    expect((await resolver.resolve({
      sessionId: 'unsafe-index',
      cwd: '/workspace/project',
      source: 'cli',
      userText: 'Review the notification privacy boundary',
      attachmentName: undefined,
    })).taskName).toBe('Review the notification privacy boundary');

    expect((await resolver.resolve({
      sessionId: 'unsafe-attachment',
      cwd: '/workspace/project',
      source: 'cli',
      userText: 'npm test -- --runInBand',
      attachmentName: '/tmp/private/report.pdf',
    })).taskName).toBe('处理文件：report.pdf');

    expect((await resolver.resolve({
      sessionId: 'fallback-1234',
      cwd: '/workspace/project',
      source: 'cli',
      userText: '[2026-07-15T12:00:00Z] ERROR synthetic failure',
      attachmentName: undefined,
    })).taskName).toBe('未命名任务 · fallback');
  });

  it('maps normalized parser sources to accurate surfaces', async () => {
    const codexDir = makeTemporaryDirectory();
    const resolver = new NotificationMetadataResolver({ codexDir, resolveGitRoot: async () => null });
    const base = {
      sessionId: 'surface-1234',
      cwd: '/workspace/project',
      userText: 'Safe task title',
      attachmentName: undefined,
    };

    expect((await resolver.resolve({ ...base, source: 'codex-desktop' })).surface).toBe('Codex Desktop');
    expect((await resolver.resolve({ ...base, source: 'exec' })).surface).toBe('CLI');
    expect((await resolver.resolve({ ...base, source: 'vscode' })).surface).toBe('IDE');
  });

  it('keeps project and attachment basenames separate from technical-title rejection', async () => {
    const codexDir = makeTemporaryDirectory();
    const resolver = new NotificationMetadataResolver({
      codexDir,
      resolveGitRoot: async () => '/workspace/go',
    });

    expect(await resolver.resolve({
      sessionId: 'basename-1234',
      cwd: '/workspace/fallback',
      source: 'cli',
      userText: '',
      attachmentName: '/tmp/private/git diff.txt',
    })).toEqual({
      projectName: 'go',
      taskName: '处理文件：git diff.txt',
      surface: 'CLI',
      shortTaskId: 'basename',
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
