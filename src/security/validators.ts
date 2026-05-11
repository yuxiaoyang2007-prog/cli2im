import { realpath } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { homedir } from 'node:os';

const MAX_INPUT_LENGTH = 50000;
const CTI_TAG_SCAN_SLACK = 1024;
const UNIX_BLOCKED_PREFIXES = ['/etc', '/usr', '/bin', '/sbin', '/var', '/tmp', '/dev', '/proc', '/sys'];
const WINDOWS_BLOCKED_PATTERNS = [
  /^[A-Za-z]:[\\/]Windows([\\/]|$)/i,
  /^[A-Za-z]:[\\/]Program Files( \(x86\))?([\\/]|$)/i,
  /^[A-Za-z]:[\\/]ProgramData([\\/]|$)/i,
  /^[A-Za-z]:[\\/]\$Recycle\.Bin/i,
];
const WINDOWS_PATH_PREFIX = /^[A-Za-z]:[\\/]/;
const WINDOWS_USERS_PREFIX = /^[A-Za-z]:[\\/]Users[\\/]/i;
const TAG_GAP = String.raw`[\s\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\x00-\x1F\x7F]*`;
const TAG_GAP_CHARS = /[\s\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\x00-\x1F\x7F]/g;
const CTI_TAG_PATTERN = new RegExp(
  `<${TAG_GAP}\\/?${TAG_GAP}`
  + `c${TAG_GAP}t${TAG_GAP}i${TAG_GAP}-${TAG_GAP}`
  + `(?:s${TAG_GAP}e${TAG_GAP}n${TAG_GAP}d${TAG_GAP}e${TAG_GAP}r|r${TAG_GAP}e${TAG_GAP}l${TAG_GAP}a${TAG_GAP}y)`
  + `\\b[^>]*\\/?${TAG_GAP}>`,
  'gi',
);
const CTI_TAG_PREFIX_PATTERN = new RegExp(
  `^<${TAG_GAP}\\/?${TAG_GAP}`
  + `c${TAG_GAP}t${TAG_GAP}i${TAG_GAP}-${TAG_GAP}`
  + `(?:s${TAG_GAP}e${TAG_GAP}n${TAG_GAP}d${TAG_GAP}e${TAG_GAP}r|r${TAG_GAP}e${TAG_GAP}l${TAG_GAP}a${TAG_GAP}y)`
  + `\\b`,
  'i',
);

export async function validateWorkingDirectory(path: string): Promise<boolean> {
  if (path.includes('..')) return false;

  const expanded = path.startsWith('~')
    ? join(homedir(), path.slice(1))
    : path;

  const resolved = await resolveExistingPathPrefix(expanded);
  if (!resolved) return false;

  return isAllowedWorkingDirectory(resolved);
}

async function resolveExistingPathPrefix(path: string): Promise<string | null> {
  let current = path;
  const missingParts: string[] = [];

  while (current && current !== dirname(current)) {
    try {
      const resolved = await realpath(current);
      return missingParts.length > 0 ? join(resolved, ...missingParts.reverse()) : resolved;
    } catch (err) {
      if (!isNotFoundError(err)) return null;
      missingParts.push(current.split(sep).pop() ?? '');
      current = dirname(current);
    }
  }

  try {
    const resolved = await realpath(current);
    return missingParts.length > 0 ? join(resolved, ...missingParts.reverse()) : resolved;
  } catch {
    return null;
  }
}

function isAllowedWorkingDirectory(path: string): boolean {
  if (path.includes('..')) return false;

  if (WINDOWS_PATH_PREFIX.test(path)) {
    for (const pattern of WINDOWS_BLOCKED_PATTERNS) {
      if (pattern.test(path)) return false;
    }
    return WINDOWS_USERS_PREFIX.test(path);
  }

  for (const prefix of UNIX_BLOCKED_PREFIXES) {
    if (path === prefix || path.startsWith(prefix + '/')) return false;
  }

  return path.startsWith('/Users/') || path.startsWith('/home/');
}

function isNotFoundError(err: unknown): boolean {
  return typeof err === 'object'
    && err !== null
    && 'code' in err
    && (err as { code?: unknown }).code === 'ENOENT';
}

export function stripCtiTags(input: string): string {
  const scanLimit = MAX_INPUT_LENGTH + CTI_TAG_SCAN_SLACK;
  const capped = input.length > scanLimit ? input.slice(0, scanLimit) : input;
  let stripped = capped.replace(CTI_TAG_PATTERN, '');
  let previous: string;
  do {
    previous = stripped;
    stripped = stripped.replace(/<\s*\/?\s*cti-(?:sender|relay)\b[^>]*\/?\s*>/gi, '');
  } while (stripped !== previous);
  stripped = stripTrailingCtiFragment(stripped);

  if (stripped.length > MAX_INPUT_LENGTH) {
    return stripTrailingCtiFragment(stripped.slice(0, MAX_INPUT_LENGTH));
  }
  return stripped;
}

function stripTrailingCtiFragment(input: string): string {
  if (input.endsWith('<')) {
    return input.slice(0, -1);
  }

  let output = '';
  let position = 0;

  while (position < input.length) {
    const tagStart = input.indexOf('<', position);
    if (tagStart === -1) {
      output += input.slice(position);
      break;
    }

    const nextTagStart = input.indexOf('<', tagStart + 1);
    const tagEnd = input.indexOf('>', tagStart + 1);
    const fragmentEnd = nextTagStart === -1 ? input.length : nextTagStart;
    const hasCompleteTagEnd = tagEnd !== -1 && tagEnd < fragmentEnd;

    if (hasCompleteTagEnd) {
      output += input.slice(position, tagEnd + 1);
      position = tagEnd + 1;
      continue;
    }

    const fragment = input.slice(tagStart, fragmentEnd);
    if (isIncompleteCtiFragment(fragment)) {
      output += input.slice(position, tagStart);
    } else {
      output += input.slice(position, fragmentEnd);
    }
    position = fragmentEnd;
  }

  return output;
}

function isIncompleteCtiFragment(fragment: string): boolean {
  const compact = fragment.replace(TAG_GAP_CHARS, '').toLowerCase();
  const body = compact.startsWith('</') ? compact.slice(2) : compact.slice(1);

  return body === 'cti'
    || body.startsWith('cti-')
    || body.startsWith('cti-s')
    || body.startsWith('cti-r')
    || CTI_TAG_PREFIX_PATTERN.test(fragment);
}

export function sanitizeInput(input: string): string {
  const stripped = stripCtiTags(input);

  const trimmed = stripped.trim();
  if (trimmed.length > MAX_INPUT_LENGTH) {
    return trimmed.slice(0, MAX_INPUT_LENGTH);
  }
  return trimmed;
}

export function sanitizeVoiceTranscript(input: string): string {
  return sanitizeInput(input);
}
