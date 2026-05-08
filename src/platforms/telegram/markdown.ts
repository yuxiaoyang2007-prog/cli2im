import { homedir } from 'node:os';
import type { CardPayload } from '../../types.js';
import type { CLISession } from '../../session/cli-scanner.js';

const MARKDOWN_V2_SPECIALS = new Set(['_', '*', '[', ']', '(', ')', '~', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!']);

export function toTelegramMarkdownV2(text: string): string {
  let result = '';
  let index = 0;

  while (index < text.length) {
    if (text.startsWith('```', index)) {
      const end = text.indexOf('```', index + 3);
      if (end === -1) {
        result += text.slice(index);
        break;
      }
      result += text.slice(index, end + 3);
      index = end + 3;
      continue;
    }

    if (text[index] === '`') {
      const end = text.indexOf('`', index + 1);
      if (end === -1) {
        result += text[index];
        index += 1;
        continue;
      }
      result += text.slice(index, end + 1);
      index = end + 1;
      continue;
    }

    const char = text[index];
    const next = text[index + 1];
    if (char === '\\' && next && MARKDOWN_V2_SPECIALS.has(next)) {
      result += char + next;
      index += 2;
      continue;
    }

    result += MARKDOWN_V2_SPECIALS.has(char) ? `\\${char}` : char;
    index += 1;
  }

  return result;
}

export function buildCLISessionText(sessions: CLISession[]): CardPayload {
  const lines: string[] = ['CLI Sessions', ''];

  for (const session of sessions) {
    const cwd = shortenPath(session.cwd);
    const title = previewText(session.title, 60);
    const meta = [
      formatRelativeTime(session.lastModified),
      session.gitBranch ?? 'HEAD',
      formatFileSize(session.fileSize),
    ].filter(Boolean).join(' · ');
    const status = formatStatus(session.status);

    lines.push(`${title} ${status}`.trim());
    lines.push(cwd);
    if (meta) lines.push(meta);
    lines.push('');
  }

  lines.push(`Showing ${sessions.length} sessions`);

  const buttons = sessions.map((session) => {
    const label = previewText(session.title, 30);
    const suffix = session.status === 'busy' ? ' (busy)' : '';
    return {
      text: `${label}${suffix}`,
      value: `resume:${session.sessionId}`,
    };
  });

  return {
    type: 'session_list',
    title: 'CLI Sessions',
    content: lines.join('\n'),
    buttons,
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
