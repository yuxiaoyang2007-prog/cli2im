import { stat, realpath } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import type { FilePayload } from '../types.js';

/**
 * Parse `[[file:<path>]]` markers from the final assistant text of a Codex
 * turn and resolve them to safe absolute paths inside the bot's working
 * directory. cli2im then sends those files to the IM client via
 * `adapter.sendFile`.
 *
 * Path safety:
 *   - candidate is resolved against `workingDirectory`
 *   - the resolved real path must stay inside the working directory
 *     (symlinks pointing outside are rejected)
 *   - must exist and be a regular file
 *   - size must be <= DEFAULT_MAX_SIZE_BYTES
 *   - duplicates are removed, total capped at DEFAULT_MAX_FILES
 *
 * Marker syntax:
 *   `[[file:./reports/eu-ppa.md]]`  (relative, recommended)
 *   `[[file:reports/eu-ppa.md]]`    (working-dir-relative)
 *   `[[file:/abs/path/inside/wd]]`  (absolute, accepted only if inside wd)
 */

export const FILE_MARKER_PATTERN = /\[\[file:\s*([^\]\n\r]+?)\s*\]\]/g;

export const DEFAULT_MAX_FILES = 10;
export const DEFAULT_MAX_SIZE_BYTES = 30 * 1024 * 1024;
export const SENDABLE_EXTENSIONS = new Set([
  // Images
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.tif', '.ico', '.svg',
  // Documents and structured data
  '.md', '.markdown', '.pdf', '.csv', '.tsv', '.xlsx', '.xls', '.docx', '.doc',
  '.pptx', '.ppt', '.txt', '.rtf', '.html', '.htm', '.json', '.jsonl', '.xml',
  '.yaml', '.yml', '.toml',
  // Code and notebooks
  '.py', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.css', '.scss', '.sql',
  '.sh', '.ipynb',
  // Archives
  '.zip', '.tar', '.gz', '.tgz', '.7z',
  // Audio/Video
  '.mp3', '.mp4', '.wav', '.ogg', '.m4a', '.mov', '.webm',
]);

export type SafeFilePayload = FilePayload & {
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
};

export function isSendableFilePath(filePath: string): boolean {
  const dotIdx = filePath.lastIndexOf('.');
  if (dotIdx < 0) return false;
  return SENDABLE_EXTENSIONS.has(filePath.slice(dotIdx).toLowerCase());
}

export function extractFileMarkerCandidates(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(FILE_MARKER_PATTERN)) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

export function stripFileMarkers(text: string): string {
  if (!text) return text;
  return text
    .replace(FILE_MARKER_PATTERN, '')
    // collapse trailing spaces on a line that was left after stripping a marker
    .replace(/[ \t]+(\r?\n)/g, '$1')
    // collapse 3+ consecutive newlines to a single blank line
    .replace(/(\r?\n){3,}/g, '\n\n');
}

export interface ResolveFileMarkersOptions {
  maxFiles?: number;
  maxSizeBytes?: number;
  log?: (msg: string) => void;
}

export async function resolveSafeFilePaths(
  candidates: string[],
  workingDirectory: string,
  options: ResolveFileMarkersOptions = {},
): Promise<string[]> {
  return (await resolveSafeFilePayloads(candidates, workingDirectory, options))
    .map((file) => file.path);
}

export async function resolveSafeFilePayloads(
  candidates: string[],
  workingDirectory: string,
  options: ResolveFileMarkersOptions = {},
): Promise<SafeFilePayload[]> {
  if (candidates.length === 0 || !workingDirectory) return [];

  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxSizeBytes = options.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
  const log = options.log;

  let workdirReal: string;
  try {
    workdirReal = await realpath(workingDirectory);
  } catch {
    workdirReal = resolve(workingDirectory);
  }

  const safe: SafeFilePayload[] = [];
  const deduped = new Set<string>();

  for (const candidate of candidates) {
    if (safe.length >= maxFiles) {
      log?.(`[file-marker] cap reached (${maxFiles}); skipping remaining`);
      break;
    }

    if (!isSendableFilePath(candidate)) {
      log?.(`[file-marker] reject "${candidate}": unsupported file extension`);
      continue;
    }

    let realAbs: string;
    try {
      const abs = isAbsolute(candidate) ? candidate : resolve(workdirReal, candidate);
      realAbs = await realpath(abs);
    } catch (err) {
      log?.(`[file-marker] reject "${candidate}": ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    const rel = relative(workdirReal, realAbs);
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      log?.(`[file-marker] reject "${candidate}": resolves outside working directory`);
      continue;
    }

    if (!isSendableFilePath(realAbs)) {
      log?.(`[file-marker] reject "${candidate}": resolved file has unsupported extension`);
      continue;
    }

    let info;
    try {
      info = await stat(realAbs);
    } catch (err) {
      log?.(`[file-marker] reject "${candidate}": stat failed: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    if (!info.isFile()) {
      log?.(`[file-marker] reject "${candidate}": not a regular file`);
      continue;
    }

    if (info.size > maxSizeBytes) {
      log?.(`[file-marker] reject "${candidate}": size ${info.size}B exceeds limit ${maxSizeBytes}B`);
      continue;
    }

    if (deduped.has(realAbs)) continue;
    deduped.add(realAbs);
    safe.push({
      path: realAbs,
      name: basename(realAbs),
      size: info.size,
      mtimeMs: info.mtimeMs,
      dev: info.dev,
      ino: info.ino,
    });
  }

  return safe;
}
