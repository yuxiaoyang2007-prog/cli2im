import { homedir } from 'node:os';
import type { CardPayload } from '../../types.js';
import type { CLISession } from '../../session/cli-scanner.js';

export function toFeishuMarkdown(content: string): string {
  let result = content;

  result = result.replace(/<a href="([^"]+)">([^<]+)<\/a>/g, '[$2]($1)');

  return result;
}

export function buildPermissionBlockedCard(command: string, _requestId: string): string {
  return [
    '**已拦截危险操作**',
    '',
    '```',
    command,
    '```',
    '',
    '回复 `/force-approve` 确认执行（60 秒超时自动拒绝）',
  ].join('\n');
}

export function buildHandoffNotification(params: {
  sessionId: string;
  workDir: string;
  agentName: string;
}): string {
  return [
    '**已接管会话**',
    '',
    `- Session: \`${params.sessionId}\``,
    `- 项目: \`${params.workDir}\``,
    `- Agent: ${params.agentName}`,
    '',
    '发消息继续推进',
  ].join('\n');
}

export function buildHandoffReleaseNotification(params: {
  sessionId: string;
  resumeCommand: string;
}): string {
  return [
    '**会话已释放**',
    '',
    '在终端运行:',
    '```',
    params.resumeCommand,
    '```',
  ].join('\n');
}

export function buildCrashNotification(code: number | null): string {
  return `**Agent 进程异常退出** (code: ${code ?? 'unknown'})\n\n发送新消息重新启动`;
}

export function buildCLISessionCard(sessions: CLISession[]): CardPayload {
  const rawElements: object[] = [];
  const fallbackLines: string[] = ['**CLI Sessions**'];

  for (const [index, session] of sessions.entries()) {
    const cwd = shortenPath(session.cwd);
    const title = previewText(session.title, 80);
    const meta = [
      formatRelativeTime(session.lastModified),
      session.gitBranch ?? 'HEAD',
      formatFileSize(session.fileSize),
    ].filter(Boolean).join(' · ');
    const status = formatStatus(session.status);
    const buttonText = session.status === 'busy' ? 'Resume (busy)' : 'Resume';

    rawElements.push({
      tag: 'markdown',
      content: [
        `**${escapeMarkdown(title)}** ${status}`,
        `${escapeMarkdown(cwd)}`,
        meta,
      ].filter(Boolean).join('\n'),
    });
    rawElements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: buttonText },
          type: 'primary',
          value: {
            action: 'resume_cli',
            sessionId: session.sessionId,
            cwd: session.cwd,
          },
        },
      ],
    });
    if (index < sessions.length - 1) {
      rawElements.push({ tag: 'hr' });
    }

    fallbackLines.push(`- \`${session.sessionId}\` ${session.status} | ${title}`);
  }

  rawElements.push({
    tag: 'note',
    elements: [
      {
        tag: 'plain_text',
        content: `Showing ${sessions.length} sessions · Claude Code only`,
      },
    ],
  });

  return {
    type: 'session_list',
    title: 'CLI Sessions',
    content: fallbackLines.join('\n'),
    rawElements,
  };
}

function shortenPath(path: string): string {
  const home = homedir();
  if (path === home) return '~';
  if (path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`;
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 3) return path || '~';
  return `.../${parts.slice(-3).join('/')}`;
}

function previewText(value: string, maxLength: number): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, maxLength - 3)}...`;
}

function formatStatus(status: CLISession['status']): string {
  if (status === 'busy') return '[busy]';
  if (status === 'stale') return '[stale]';
  if (status === 'historical') return '';
  return '[idle]';
}

function formatRelativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 0) return 'just now';

  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds} seconds ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;

  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function formatFileSize(bytes: number | undefined): string | undefined {
  if (bytes === undefined) return undefined;
  if (bytes < 1024) return `${bytes}B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)}KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)}MB`;
}

function escapeBackticks(value: string): string {
  return value.replace(/`/g, "'");
}

function escapeMarkdown(value: string): string {
  return value.replace(/\*/g, '\\*');
}
