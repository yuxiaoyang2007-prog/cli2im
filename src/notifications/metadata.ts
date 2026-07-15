import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, join } from 'node:path';
import type { CodexSurface } from './types.js';
import { readHeadTailWindow } from '../session/file-window.js';

const execFileAsync = promisify(execFile);

const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/gi;
const OPENAI_STYLE_KEY = /\b(?:sk|sess)-[A-Za-z0-9_-]{12,}\b/g;
const MARKDOWN_LINK = /\[([^\]]+)]\([^\s)]+\)/g;
const CODE_FENCE = /```[\s\S]*?```/g;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const IMAGE_EXTENSION = /\.(?:avif|bmp|gif|heic|jpeg|jpg|png|tiff|webp)$/i;
const CODE_LINE = /^(?:(?:async\s+)?function|const|let|var|class|interface|type|enum|namespace|import|export|def)\b|^(?:console\.log|print)\s*\(|^(?:[A-Za-z_$][\w$]*\.)+[A-Za-z_$][\w$]*\s*\([^)]*\)\s*;?$|^[A-Za-z_$][\w$]*(?:\.[\w$]+)*\s*=(?!=)\s*\S|^\{\s*"[^"]+"\s*:|^\[\s*(?:\{|\[|"|-?\d|true\b|false\b|null\b)|^<[/!]?[A-Za-z][^>]*>/;
const DIFF_LINE = /^(?:diff --git\b|index [0-9a-f]+\.{2}[0-9a-f]+\b|---\s+\S+|\+\+\+\s+\S+|@@\s+-\d)/i;
const LOG_LINE = /^(?:\[\d{4}-\d{2}-\d{2}[T ][^\]]*]\s*|\d{4}-\d{2}-\d{2}[T ]\S+\s+)(?:TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\b|^(?:TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\s+[\[:]/i;
const RAW_COMMAND_HEADS = new Set([
  'awk', 'bash', 'brew', 'bun', 'cargo', 'cat', 'cd', 'cmake', 'curl', 'deno',
  'deploy', 'docker', 'echo', 'find', 'gh', 'git', 'go', 'grep', 'kubectl', 'ls',
  'make', 'node', 'npm', 'npx', 'pip', 'pip3', 'pnpm', 'pwd', 'python', 'python3',
  'rg', 'rm', 'rsync', 'scp', 'sed', 'sh', 'ssh', 'wget', 'yarn', 'zsh',
]);
const COMMAND_SHAPED_ARGUMENT = /(?:^|\s)(?:--?[A-Za-z0-9][A-Za-z0-9_-]*(?:=\S*)?|(?:\.{1,2}|~)?[\\/]\S+)/;
const RELATIVE_EXECUTABLE = /^(?:\.{1,2}|~)[\\/]\S+/;
const SHELL_SYNTAX = /&&|\|\||(?:^|\s)\|(?!\|)|(?:^|\s)(?:>>?|<<?)|;(?=\s|$)/;
const SQL_LINE = /^(?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|WITH)\b.*(?:\bFROM\b|\bINTO\b|\bTABLE\b|\bSET\b|\*)/;
const CONTROL_FLOW_LINE = /^(?:if|for|while|switch|try|catch)\s*\(/;
const ERROR_OR_STACK_LINE = /^(?:(?:[A-Za-z_$][\w$.]*)?(?:Error|Exception)):\s+\S|^at\s+\S+(?:\s+\(|:\d)/i;
const PYTHON_STACK_FRAME = /^\s*File\s+(?:"[^"]+"|\S+),\s+line\s+\d+/i;
const TRACEBACK_HEADER = /^Traceback \(most recent call last\):$/i;
const SIMPLE_CALL_LINE = /^[A-Za-z_$][\w$]*\s*\([^)]*\)\s*;?$/;

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
    .replace(PRIVATE_KEY, '[REDACTED]')
    .replace(OPENAI_STYLE_KEY, '[REDACTED]');

  sanitized = redactNamedSecrets(sanitized);
  const uriSafe = sanitizeUris(sanitized);
  if (uriSafe === null) return '';

  const firstMeaningfulLine = uriSafe
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? '';
  if (isHighConfidenceRawCommand(firstMeaningfulLine)) return '';
  const pathSafe = sanitizeAbsolutePaths(firstMeaningfulLine);
  if (pathSafe === null) return '';
  const normalized = pathSafe.replace(/[ \t]+/g, ' ').trim();

  return isUnsafeTechnicalTitle(normalized)
    ? ''
    : truncateTitle(normalized);
}

export function sanitizeMetadataBasename(value: string): string {
  const name = basename(value.replaceAll('\\', '/'));
  const redacted = redactNamedSecrets(name)
    .replace(PRIVATE_KEY, '[REDACTED]')
    .replace(OPENAI_STYLE_KEY, '[REDACTED]')
    .replace(/[ \t]+/g, ' ')
    .trim();
  return truncateTitle(redacted);
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
  const name = sanitizeMetadataBasename(value);
  if (!name) return '';
  return `${IMAGE_EXTENSION.test(name) ? '分析图片' : '处理文件'}：${name}`;
}

function safeProjectName(value: string | null): string {
  if (!value) return '';
  const name = basename(value.replaceAll('\\', '/'));
  if (!name || name === '.' || name === '/') return '';
  return sanitizeMetadataBasename(name);
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
    case 'exec':
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

function isUnsafeTechnicalTitle(value: string): boolean {
  if (SHELL_SYNTAX.test(value)
    || CODE_LINE.test(value)
    || DIFF_LINE.test(value)
    || LOG_LINE.test(value)
    || SQL_LINE.test(value)
    || CONTROL_FLOW_LINE.test(value)
    || ERROR_OR_STACK_LINE.test(value)
    || PYTHON_STACK_FRAME.test(value)
    || TRACEBACK_HEADER.test(value)
    || SIMPLE_CALL_LINE.test(value)) {
    return true;
  }

  return false;
}

function isHighConfidenceRawCommand(value: string): boolean {
  if (RELATIVE_EXECUTABLE.test(value)) return true;
  const head = /^(\S+)/.exec(value)?.[1];
  if (!head || !/^[a-z][a-z0-9._-]*$/.test(head)) return false;
  return RAW_COMMAND_HEADS.has(head) || COMMAND_SHAPED_ARGUMENT.test(value);
}

function redactNamedSecrets(value: string): string {
  const pattern = /\b(token|password|passwd|secret|cookie|api[_-]?key)\s*[:=]\s*/gi;
  let result = '';
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(value)) !== null) {
    result += value.slice(cursor, match.index);
    result += `${match[1]}=[REDACTED]`;

    let valueEnd = pattern.lastIndex;
    const quote = value[valueEnd];
    if (quote === '"' || quote === "'") {
      valueEnd += 1;
      let closed = false;
      while (valueEnd < value.length) {
        if (value[valueEnd] === '\\') {
          valueEnd = Math.min(value.length, valueEnd + 2);
          continue;
        }
        if (value[valueEnd] === quote) {
          valueEnd += 1;
          closed = true;
          break;
        }
        valueEnd += 1;
      }
      if (!closed) valueEnd = value.length;
    } else {
      while (valueEnd < value.length && !/\s/.test(value[valueEnd])) valueEnd += 1;
    }

    cursor = valueEnd;
    pattern.lastIndex = valueEnd;
  }

  return result + value.slice(cursor);
}

function sanitizeUris(value: string): string | null {
  const pattern = /\b([A-Za-z][A-Za-z0-9+.-]*):(?:(\/\/)?)([^\s]+)/g;
  let result = '';
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(value)) !== null) {
    result += value.slice(cursor, match.index);
    const scheme = match[1].toLowerCase();
    const full = match[0];

    if (scheme === 'http' || scheme === 'https') {
      result += full.replace(/[?#].*$/, '');
    } else {
      const { core, suffix } = splitTrailingPunctuation(match[3].split(/[?#]/, 1)[0]);
      if (hasAmbiguousPathContinuation(value.slice(pattern.lastIndex))) return null;
      const safeName = basename(core.replaceAll('\\', '/'));
      result += `${safeName || '[REDACTED]'}${suffix}`;
    }

    cursor = pattern.lastIndex;
  }

  return result + value.slice(cursor);
}

function sanitizeAbsolutePaths(value: string): string | null {
  const quoted = value.replace(
    /(["'])(\/(?!\/)[^"'\r\n]*)\1/g,
    (_match, _quote: string, path: string) => basename(path.replaceAll('\\', '/')),
  );
  const pattern = /(^|[^:/A-Za-z0-9._-]|-[A-Za-z])\/(?!\/)([^\s]+)/gm;
  let result = '';
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(quoted)) !== null) {
    const { core, suffix } = splitTrailingPunctuation(match[2]);
    if (hasAmbiguousPathContinuation(quoted.slice(pattern.lastIndex))) return null;
    result += quoted.slice(cursor, match.index);
    result += `${match[1]}${basename(core.replaceAll('\\', '/'))}${suffix}`;
    cursor = pattern.lastIndex;
  }

  return result + quoted.slice(cursor);
}

function hasAmbiguousPathContinuation(remainder: string): boolean {
  return /^\s/.test(remainder) && /[\\/]/.test(remainder);
}

function splitTrailingPunctuation(value: string): { core: string; suffix: string } {
  const match = /([,.;!?)\]}]+)$/.exec(value);
  return match
    ? { core: value.slice(0, -match[1].length), suffix: match[1] }
    : { core: value, suffix: '' };
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
