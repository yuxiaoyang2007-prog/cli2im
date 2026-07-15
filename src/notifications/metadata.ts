import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, join } from 'node:path';
import type { CodexSurface } from './types.js';
import { readHeadTailWindow } from '../session/file-window.js';

const execFileAsync = promisify(execFile);

const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/gi;
const OPENAI_STYLE_KEY = /\b(?:sk|sess)-[A-Za-z0-9_-]{12,}\b/g;
const NAMED_SECRET = /\b(token|password|passwd|secret|cookie|api[_-]?key)\s*[:=]\s*\S+/gi;
const HOME_PATH = /\/(?:Users|home)\/[^/\s]+\//g;
const URL_QUERY = /(https?:\/\/[^\s?#]+)(?:[?#]\S*)/g;

const HOME_FULL_PATH = /\/(?:Users|home)\/[^/\s]+\/(?:[^\s/]+\/)*([^\s/]+)/g;
const MARKDOWN_LINK = /\[([^\]]+)]\([^\s)]+\)/g;
const CODE_FENCE = /```[\s\S]*?```/g;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const IMAGE_EXTENSION = /\.(?:avif|bmp|gif|heic|jpeg|jpg|png|tiff|webp)$/i;

const WRAPPER_BLOCKS = [
  'environment_context',
  'INSTRUCTIONS',
  'system',
  'developer',
  'tool',
  'tool_result',
];

export interface NotificationMetadataInput {
  sessionId: string;
  cwd: string;
  source: string;
  userText: string;
  attachmentName?: string;
}

export interface ResolvedNotificationMetadata {
  projectName: string;
  taskName: string;
  surface: CodexSurface;
  shortTaskId: string;
}

export interface NotificationMetadataResolverOptions {
  codexDir: string;
  resolveGitRoot?: (cwd: string) => Promise<string | null>;
}

export function sanitizeTaskTitle(value: string): string {
  let sanitized = value;

  for (const tag of WRAPPER_BLOCKS) {
    const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    sanitized = sanitized.replace(
      new RegExp(`<${escapedTag}\\b[^>]*>[\\s\\S]*?<\\/${escapedTag}>`, 'gi'),
      '\n',
    );
  }

  sanitized = sanitized
    .replace(/^\s*#\s*AGENTS\.md instructions\s*$/gim, '\n')
    .replace(CODE_FENCE, '\n')
    .replace(MARKDOWN_LINK, '$1')
    .replace(URL_QUERY, '$1')
    .replace(PRIVATE_KEY, '[REDACTED]')
    .replace(OPENAI_STYLE_KEY, '[REDACTED]')
    .replace(NAMED_SECRET, (_match, name: string) => `${name}=[REDACTED]`)
    .replace(HOME_FULL_PATH, '$1')
    .replace(HOME_PATH, '')
    .replace(/[ \t]+/g, ' ');

  const firstMeaningfulLine = sanitized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? '';

  return truncateTitle(firstMeaningfulLine);
}

export class NotificationMetadataResolver {
  private readonly codexDir: string;
  private readonly resolveGitRoot: (cwd: string) => Promise<string | null>;
  private readonly gitRootByCwd = new Map<string, Promise<string | null>>();

  constructor(options: NotificationMetadataResolverOptions) {
    this.codexDir = options.codexDir;
    this.resolveGitRoot = options.resolveGitRoot ?? defaultResolveGitRoot;
  }

  async resolve(input: NotificationMetadataInput): Promise<ResolvedNotificationMetadata> {
    const shortTaskId = Array.from(input.sessionId).slice(0, 8).join('') || 'unknown';
    const [gitRoot, sessionTitle] = await Promise.all([
      this.gitRootFor(input.cwd),
      this.findSessionTitle(input.sessionId),
    ]);

    const projectName = safeProjectName(gitRoot)
      || safeProjectName(input.cwd)
      || '未识别项目';
    const taskName = sanitizeTaskTitle(sessionTitle ?? '')
      || sanitizeTaskTitle(input.userText)
      || attachmentTitle(input.attachmentName)
      || `未命名任务 · ${shortTaskId}`;

    return {
      projectName,
      taskName,
      surface: resolveSurface(input.source),
      shortTaskId,
    };
  }

  private gitRootFor(cwd: string): Promise<string | null> {
    const existing = this.gitRootByCwd.get(cwd);
    if (existing) return existing;

    const pending = cwd ? this.resolveGitRoot(cwd).catch(() => null) : Promise.resolve(null);
    this.gitRootByCwd.set(cwd, pending);
    return pending;
  }

  private async findSessionTitle(sessionId: string): Promise<string | undefined> {
    const content = await readHeadTailWindow(join(this.codexDir, 'session_index.jsonl'));
    let title: string | undefined;

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as unknown;
        if (!isRecord(entry) || entry.id !== sessionId || typeof entry.thread_name !== 'string') {
          continue;
        }
        title = entry.thread_name;
      } catch {
        // Head/tail windows can contain partial or malformed lines.
      }
    }

    return title;
  }
}

async function defaultResolveGitRoot(cwd: string): Promise<string | null> {
  try {
    const result = await execFileAsync(
      'git',
      ['-C', cwd, 'rev-parse', '--show-toplevel'],
      { encoding: 'utf8' },
    );
    const root = result.stdout.trim();
    return root || null;
  } catch {
    return null;
  }
}

function attachmentTitle(value: string | undefined): string {
  if (!value) return '';
  const name = sanitizeTaskTitle(basename(value.replaceAll('\\', '/')));
  if (!name) return '';
  return `${IMAGE_EXTENSION.test(name) ? '分析图片' : '处理文件'}：${name}`;
}

function safeProjectName(value: string | null): string {
  if (!value) return '';
  const name = basename(value.replaceAll('\\', '/'));
  if (!name || name === '.' || name === '/') return '';
  return sanitizeTaskTitle(name);
}

function resolveSurface(source: string): CodexSurface {
  switch (source.trim().toLowerCase()) {
    case 'chatgpt':
    case 'chatgpt-work':
    case 'chatgpt_work':
    case 'work':
      return 'ChatGPT Work';
    case 'codex-desktop':
    case 'codex_desktop':
    case 'desktop':
      return 'Codex Desktop';
    case 'cli':
    case 'codex-cli':
    case 'codex_cli':
      return 'CLI';
    case 'ide':
    case 'vscode':
    case 'jetbrains':
      return 'IDE';
    case 'codexbot':
    case 'cli2im':
      return 'codexbot';
    default:
      return 'Codex';
  }
}

function truncateTitle(value: string): string {
  const codePoints = Array.from(value);
  const cjkCount = codePoints.filter((character) => CJK.test(character)).length;
  const maxLength = cjkCount > codePoints.length / 2 ? 40 : 80;
  return codePoints.slice(0, maxLength).join('');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
