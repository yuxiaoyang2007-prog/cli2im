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
  const credentialCases = [
    ['GitHub classic PAT', 'ghp_1234567890abcdefghijklmnopqrstuvwxyzAB', 'Review [REDACTED]'],
    ['GitHub fine-grained PAT', 'github_pat_11AA0abcdefghijklmnopqrstuvwxyz_1234567890', 'Review [REDACTED]'],
    ['AWS access key', 'AKIAIOSFODNN7EXAMPLE', 'Review [REDACTED]'],
    ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c', 'Review [REDACTED]'],
    ['Bearer credential', 'Bearer mF_9xQ7vK2pL8sN4dR6tY1wB3cE5hJ0z', 'Review [REDACTED]'],
    ['short Bearer credential', 'Bearer abc123', 'Review [REDACTED]'],
    ['Authorization credential', 'Authorization: Basic YWxhZGRpbjpvcGVuc2VzYW1l', 'Review [REDACTED]'],
    ['quoted auth credential', 'auth="Bearer abc123"', 'Review [REDACTED]'],
    ['quoted arbitrary auth credential', 'auth="alpha beta secret"', 'Review [REDACTED]'],
    ['short auth assignment', 'auth=abc123', 'Review [REDACTED]'],
    ['quoted Authorization value', 'Authorization: "callback"', 'Review [REDACTED]'],
    ['short Basic credential', 'Basic YTpwYXNz', 'Review [REDACTED]'],
    ['signed URL', 'https://example.test/download?X-Amz-Credential=AKIAIOSFODNN7EXAMPLE&X-Amz-Signature=0123456789abcdef0123456789abcdef', 'Review https://example.test/download'],
    ['Slack webhook URL', 'https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX', 'Review https://hooks.slack.com/[REDACTED]'],
    ['generic secret-bearing webhook URL', 'https://example.test/api/webhook/mF_9xQ7vK2pL8sN4dR6tY1wB3cE5hJ0z', 'Review https://example.test/api/webhook/[REDACTED]'],
    ['Teams-style webhook URL', 'https://example.test/api/webhookb2/short-secret-id', 'Review https://example.test/api/webhookb2/[REDACTED]'],
    ['labeled secret path URL', 'https://example.test/callback/token/short-secret-id', 'Review https://example.test/callback/token/[REDACTED]'],
    ['ambiguous high-entropy value', 'mF_9xQ7vK2pL8sN4dR6tY1wB3cE5hJ0z', 'Review [REDACTED]'],
    ['alphabetic mixed-case high-entropy value', 'QzLmNpRtVxBcDfGhJkSwYuAeIo', 'Review [REDACTED]'],
    ['alphabetic lowercase high-entropy value', 'qwertyuiopasdfghjklzxcvbnm', 'Review [REDACTED]'],
    ['ambiguous base64 credential', 'Abcdefghijklmnop/QR234567890+=', 'Review [REDACTED]'],
    ['ambiguous hex credential', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'Review [REDACTED]'],
  ] as const;

  it.each(credentialCases)('redacts a bare %s from a natural title', (_kind, credential, expected) => {
    const title = sanitizeTaskTitle(`Review ${credential}`);

    expect(title).toBe(expected);
    expect(title).not.toContain(credential);
  });

  it.each(credentialCases)('rejects a bare %s as the entire title', (_kind, credential) => {
    expect(sanitizeTaskTitle(credential)).toBe('');
  });

  it.each([
    'gho_1234567890abcdefghijklmnopqrstuvwxyzAB',
    'ghu_1234567890abcdefghijklmnopqrstuvwxyzAB',
    'ghs_1234567890abcdefghijklmnopqrstuvwxyzAB',
    'ghr_1234567890abcdefghijklmnopqrstuvwxyzAB',
    'ASIAIOSFODNN7EXAMPLE',
  ])('redacts an additional PAT or temporary AWS credential family: %s', (credential) => {
    expect(sanitizeTaskTitle(`Review ${credential}`)).toBe('Review [REDACTED]');
  });

  it.each([
    'CodexNotificationMetadataResolver',
    'CodexNotificationMetadataResolverV2',
    'NotificationDeliveryRetryHandler2026',
    'codex_notification_delivery_timeout',
    'notification-delivery-retry-handler',
  ])('preserves a common non-secret identifier as a task title: %s', (identifier) => {
    expect(sanitizeTaskTitle(identifier)).toBe(identifier);
  });

  it.each([
    'Authorization: callback',
    'Fix auth: login redirect',
  ])('preserves ordinary authorization prose: %s', (title) => {
    expect(sanitizeTaskTitle(title)).toBe(title);
  });

  it.each([
    'Review Authorization: Bearer abc123',
    'Review auth=ghp_1234567890abcdefghijklmnopqrstuvwxyzAB',
  ])('redacts an explicit or credential-shaped authorization value: %s', (title) => {
    expect(sanitizeTaskTitle(title)).toBe('Review [REDACTED]');
  });

  it.each([
    'Review Basic YTpwYXNz.',
    'Review "Basic YTpwYXNz"',
    'Review [Basic YTpwYXNz]',
    'Review (Basic YTpwYXNz)!',
  ])('redacts a valid Basic credential before ordinary punctuation: %s', (title) => {
    const sanitized = sanitizeTaskTitle(title);

    expect(sanitized).toContain('[REDACTED]');
    expect(sanitized).not.toContain('YTpwYXNz');
  });

  it('removes secrets URLs home paths and instruction wrappers from a task title', () => {
    const title = sanitizeTaskTitle(`
<environment_context>ignored</environment_context>
请部署 "/Users/test/private/repo" token=sk-live-secret https://example.test/a?token=abc
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
      '请检查 "/tmp/private/run.log" 和 "/var/log/service/app.log" 后继续',
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

  it('removes HTTP userinfo together with query and fragment data', () => {
    const title = sanitizeTaskTitle(
      'Open https://alice:synthetic-password@example.test/private/report?token=x',
    );

    expect(title).toBe('Open https://example.test/private/report');
    expect(title).not.toContain('alice');
    expect(title).not.toContain('synthetic-password');
    expect(title).not.toContain('token=x');
  });

  it.each([
    'Analyze /tmp/private folder/report.csv and summarize',
    'Analyze /tmp/private with spaces/report.csv',
    'Analyze /tmp/private.v1 with spaces/report.csv',
    'Analyze /tmp/report.csv folder/private.csv',
  ])('rejects an ambiguous unquoted absolute path containing spaces', (value) => {
    expect(sanitizeTaskTitle(value)).toBe('');
  });

  it.each([
    ['absolute path', 'Analyze /tmp/private/report.csv and summarize'],
    ['file URI', 'Analyze file:///tmp/private/report.csv and summarize'],
  ])('uses a clear filename as the whitespace boundary for an %s', (_kind, value) => {
    expect(sanitizeTaskTitle(value)).toBe('Analyze report.csv and summarize');
  });

  it('shields a complete HTTP URL while checking an unquoted local path tail', () => {
    const title = sanitizeTaskTitle(
      'Analyze /tmp/report.csv and compare https://example.test/a?token=x',
    );

    expect(title).toBe('Analyze report.csv and compare https://example.test/a');
    expect(title).not.toContain('/tmp/');
    expect(title).not.toContain('?token=x');
  });

  it('treats separators after a clause connector as unrelated prose', () => {
    expect(sanitizeTaskTitle('Analyze /tmp/report.csv and compare A/B')).toBe(
      'Analyze report.csv and compare A/B',
    );
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
    ['lowercase log line', '[2026-07-15T12:00:00.000Z] error synthetic failure'],
    ['lowercase command', 'brew install package'],
    ['lowercase CLI command', 'gh pr view 1'],
    ['SQL', 'SELECT * FROM users;'],
    ['control-flow code', 'if (ready) deploy();'],
    ['error line', 'Error: failed'],
    ['lowercase error line', 'error: failed'],
    ['stack line', 'at deploy (/tmp/private/app.js:10:2)'],
    ['Python stack frame', '  File "/tmp/private/app.py", line 12, in deploy'],
    ['Traceback header', 'Traceback (most recent call last):'],
    ['lowercase Traceback header', 'traceback (most recent call last):'],
    ['single-word command', 'ls'],
    ['simple call', 'deploy()'],
    ['ambiguous lowercase command', 'deploy production'],
    ['flag-shaped command', 'runner --verbose'],
    ['relative-path-shaped command', 'runner ./script'],
    ['Codex CLI command', 'codex update'],
    ['Lark CLI command', 'lark-cli auth scopes'],
    ['OpenClaw command', 'openclaw gateway status'],
    ['SQLite command', 'sqlite3 data.db .tables'],
    ['absolute executable command', '/usr/bin/custom deploy'],
    ['find command', 'find ./src -name notification'],
    ['find relative-path command', 'find src/notifications'],
    ['find bare argument', 'find src'],
    ['Go subcommand', 'go test ./...'],
    ['Go flag command', 'go --version'],
    ['Go help command', 'go help'],
    ['Make target', 'make release'],
    ['env command', 'env codex update'],
    ['Hermes command', 'hermes chat'],
    ['VS Code command', 'code .'],
    ['shell-prompt-prefixed command', '$ codex update'],
    ['alternate-prompt-prefixed command', '❯ openclaw gateway status'],
    ['list-prefixed command', '- lark-cli auth scopes'],
    ['command with trailing CJK', 'env codex update 中文'],
    ['percent-prefixed command', '% codex update'],
    ['hash-prefixed command', '# openclaw gateway status'],
    ['numbered-list command', '1. lark-cli auth scopes'],
    ['checkbox-list command', '- [ ] codex update'],
    ['percent-prefixed code', '% const value = true'],
    ['percent-prefixed markup code', '% <Component />'],
    ['percent-prefixed log', '% [2026-07-15T12:00:00Z] error synthetic failure'],
    ['percent-prefixed custom-level log', '% [2026-07-15T12:00:00Z] NOTICE synthetic restart'],
    ['hash-prefixed custom-level log', '# 2026-07-15T12:00:00Z CRITICAL synthetic failure'],
    ['percent-prefixed executable path', '% /usr/bin/custom deploy'],
    ['parenthesized shell wrapper', '(read notification)'],
    ['backtick shell wrapper', '`read notification`'],
    ['non-allowlisted hyphenated head', 'review-tool run'],
    ['shell redirection', 'deploy > /tmp/private/output.log'],
    ['shell operator expression', 'build && deploy'],
  ])('rejects a task title that is principally a %s', (_kind, value) => {
    expect(sanitizeTaskTitle(value)).toBe('');
  });

  it.each([
    './deploy --force',
    '../deploy --force',
    '~/deploy --force',
  ])('rejects a relative executable invocation beginning with %s', (value) => {
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
    expect(sanitizeTaskTitle('Review basic authentication behavior')).toBe(
      'Review basic authentication behavior',
    );
  });

  it.each([
    'please review the notification report',
    'fix the notification bug',
    'explain why the notification failed',
    'summarize recent notification changes',
    'implement notification handling',
    'read the report',
  ])('accepts ordinary lowercase prose: %s', (value) => {
    expect(sanitizeTaskTitle(value)).toBe(value);
  });

  it.each([
    'find the notification bug',
    'go review the deployment flow',
    'make the release safer',
  ])('accepts an ambiguous command head in lowercase prose: %s', (value) => {
    expect(sanitizeTaskTitle(value)).toBe(value);
  });

  it.each([
    'please', 'fix', 'explain', 'summarize', 'implement', 'read', 'review', 'analyze',
    'investigate', 'diagnose', 'design', 'create', 'build', 'update', 'add', 'remove',
    'improve', 'verify', 'check', 'prepare', 'write', 'translate', 'compare', 'inspect',
    'audit', 'document', 'refactor', 'optimize', 'debug', 'troubleshoot', 'research',
    'assess', 'evaluate',
  ])('accepts the centralized natural request head: %s', (head) => {
    expect(sanitizeTaskTitle(`${head} notification handling`)).toBe(
      `${head} notification handling`,
    );
  });

  it('accepts an allowlisted natural request head as a single-word title', () => {
    expect(sanitizeTaskTitle('review')).toBe('review');
  });

  it.each(['$', '❯', '>', '-', '*', '•'])(
    'strips the %s prompt or list prefix from a safe natural request',
    (prefix) => {
      expect(sanitizeTaskTitle(`${prefix} implement notification handling`)).toBe(
        'implement notification handling',
      );
    },
  );

  it('keeps a genuine CJK natural request without a command prefix', () => {
    expect(sanitizeTaskTitle('请检查通知流程')).toBe('请检查通知流程');
  });

  it.each([
    ['% implement notification handling', 'implement notification handling'],
    ['# explain why notifications fail', 'explain why notifications fail'],
    ['1. summarize notification changes', 'summarize notification changes'],
    ['- [ ] read the report', 'read the report'],
  ])('normalizes arbitrary punctuation or list syntax in %s', (value, expected) => {
    expect(sanitizeTaskTitle(value)).toBe(expected);
  });

  it('rejects a title with no Unicode letter', () => {
    expect(sanitizeTaskTitle('1234 - [ ]')).toBe('');
  });

  it('truncates CJK-heavy and Latin-heavy titles by Unicode code points', () => {
    expect(Array.from(sanitizeTaskTitle('测'.repeat(45)))).toHaveLength(40);
    expect(Array.from(sanitizeTaskTitle(`review ${'a'.repeat(90)}`))).toHaveLength(80);
    expect(Array.from(sanitizeTaskTitle(`review ${'😀'.repeat(90)}`))).toHaveLength(80);
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

  it.each([
    ['GitHub PAT', 'ghp_1234567890abcdefghijklmnopqrstuvwxyzAB'],
    ['AWS access key', 'AKIAIOSFODNN7EXAMPLE'],
    ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'],
    ['Bearer credential', 'Bearer mF_9xQ7vK2pL8sN4dR6tY1wB3cE5hJ0z'],
    ['webhook URL', 'https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX'],
    ['high-entropy credential', 'mF_9xQ7vK2pL8sN4dR6tY1wB3cE5hJ0z'],
    ['alphabetic mixed-case credential', 'QzLmNpRtVxBcDfGhJkSwYuAeIo'],
    ['alphabetic lowercase credential', 'qwertyuiopasdfghjklzxcvbnm'],
  ])('falls back instead of placing a bare %s in notification fields', async (_kind, credential) => {
    const codexDir = makeTemporaryDirectory();
    await writeFile(join(codexDir, 'session_index.jsonl'), JSON.stringify({
      id: 'credential-session',
      thread_name: credential,
    }), 'utf8');
    const resolver = new NotificationMetadataResolver({
      codexDir,
      resolveGitRoot: async () => null,
    });

    const result = await resolver.resolve({
      sessionId: 'credential-session',
      cwd: '/workspace/safe-project',
      source: 'cli',
      userText: credential,
      attachmentName: undefined,
    });

    expect(result.taskName).toBe('未命名任务 · credenti');
    expect(JSON.stringify(result)).not.toContain(credential);
  });

  it('rejects a credential-like repository basename as the project field', async () => {
    const codexDir = makeTemporaryDirectory();
    const credential = 'mF_9xQ7vK2pL8sN4dR6tY1wB3cE5hJ0z';
    const resolver = new NotificationMetadataResolver({
      codexDir,
      resolveGitRoot: async () => `/workspace/${credential}`,
    });

    const result = await resolver.resolve({
      sessionId: 'project-secret',
      cwd: `/workspace/${credential}`,
      source: 'cli',
      userText: 'Review notification privacy',
      attachmentName: undefined,
    });

    expect(result.projectName).toBe('未识别项目');
    expect(JSON.stringify(result)).not.toContain(credential);
  });

  it.each([
    'CodexNotificationMetadataResolver',
    'CodexNotificationMetadataResolverV2',
    'NotificationDeliveryRetryHandler2026',
    'codex_notification_delivery_timeout',
    'notification-delivery-retry-handler',
  ])('preserves a common identifier as project and task metadata: %s', async (identifier) => {
    const codexDir = makeTemporaryDirectory();
    const resolver = new NotificationMetadataResolver({
      codexDir,
      resolveGitRoot: async () => `/workspace/${identifier}`,
    });

    expect(await resolver.resolve({
      sessionId: 'identifier-session',
      cwd: `/workspace/${identifier}`,
      source: 'cli',
      userText: identifier,
      attachmentName: undefined,
    })).toMatchObject({
      projectName: identifier,
      taskName: identifier,
    });
  });

  it('falls back when a short valid Basic credential is the only task title', async () => {
    const codexDir = makeTemporaryDirectory();
    const resolver = new NotificationMetadataResolver({
      codexDir,
      resolveGitRoot: async () => '/workspace/safe-project',
    });

    const result = await resolver.resolve({
      sessionId: 'basic-credential-session',
      cwd: '/workspace/safe-project',
      source: 'cli',
      userText: 'Basic YTpwYXNz',
      attachmentName: undefined,
    });

    expect(result.taskName).toBe('未命名任务 · basic-cr');
    expect(JSON.stringify(result)).not.toContain('YTpwYXNz');
  });

  it('redacts a short valid Basic credential before punctuation in resolved metadata', async () => {
    const codexDir = makeTemporaryDirectory();
    const resolver = new NotificationMetadataResolver({
      codexDir,
      resolveGitRoot: async () => '/workspace/safe-project',
    });

    const result = await resolver.resolve({
      sessionId: 'basic-punctuation-session',
      cwd: '/workspace/safe-project',
      source: 'cli',
      userText: 'Review Basic YTpwYXNz.',
      attachmentName: undefined,
    });

    expect(result.taskName).toBe('Review [REDACTED].');
    expect(JSON.stringify(result)).not.toContain('YTpwYXNz');
  });

  it.each([
    'Review auth=abc123',
    'Review auth="alpha beta secret"',
  ])('fails closed for auth assignments in resolved task metadata: %s', async (title) => {
    const codexDir = makeTemporaryDirectory();
    const resolver = new NotificationMetadataResolver({
      codexDir,
      resolveGitRoot: async () => '/workspace/safe-project',
    });

    const result = await resolver.resolve({
      sessionId: 'auth-assignment-session',
      cwd: '/workspace/safe-project',
      source: 'cli',
      userText: title,
      attachmentName: undefined,
    });

    expect(result.taskName).toBe('Review [REDACTED]');
    expect(JSON.stringify(result)).not.toContain('abc123');
    expect(JSON.stringify(result)).not.toContain('alpha beta secret');
  });

  it.each([
    'Authorization: callback',
    'Fix auth: login redirect',
  ])('keeps ordinary authorization prose in resolved task metadata: %s', async (title) => {
    const codexDir = makeTemporaryDirectory();
    const resolver = new NotificationMetadataResolver({
      codexDir,
      resolveGitRoot: async () => '/workspace/safe-project',
    });

    expect((await resolver.resolve({
      sessionId: 'auth-prose-session',
      cwd: '/workspace/safe-project',
      source: 'cli',
      userText: title,
      attachmentName: undefined,
    })).taskName).toBe(title);
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
