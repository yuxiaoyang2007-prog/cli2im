import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  readdirSync,
  renameSync,
  truncateSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';

const DEFAULT_LOG_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_LOG_MAX_BACKUPS = 3;
const DEFAULT_MEDIA_MAX_AGE_MS = 14 * 24 * 3600_000;

/**
 * Copy-truncates `logPath` once it reaches `maxBytes` so open file descriptors
 * (such as launchd StandardOutPath/StandardErrorPath) remain valid on the same inode.
 */
export function rotateLogFileIfNeeded(
  logPath: string,
  opts: { maxBytes?: number; maxBackups?: number } = {},
): boolean {
  const maxBytes = opts.maxBytes ?? DEFAULT_LOG_MAX_BYTES;
  const maxBackups = opts.maxBackups ?? DEFAULT_LOG_MAX_BACKUPS;
  if (maxBytes <= 0 || maxBackups < 1) return false;

  let info;
  try {
    info = lstatSync(logPath);
  } catch {
    return false;
  }
  if (!info.isFile() || info.size < maxBytes) return false;

  for (let i = maxBackups - 1; i >= 1; i -= 1) {
    const src = `${logPath}.${i}`;
    const dst = `${logPath}.${i + 1}`;
    if (existsSync(src)) {
      renameSync(src, dst);
      chmodSync(dst, 0o600);
    }
  }

  const firstBackup = `${logPath}.1`;
  copyFileSync(logPath, firstBackup);
  chmodSync(firstBackup, 0o600);
  truncateSync(logPath, 0);
  chmodSync(logPath, 0o600);
  return true;
}

/**
 * Removes old downloaded inbound attachment files in `mediaDir` past `maxAgeMs`.
 * Preserves `.gitignore`, subdirectories, and symlinks.
 */
export function pruneStaleMediaFiles(
  mediaDir: string,
  opts: { now?: number; maxAgeMs?: number } = {},
): number {
  const now = opts.now ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MEDIA_MAX_AGE_MS;
  const cutoff = now - maxAgeMs;

  let entries: string[];
  try {
    entries = readdirSync(mediaDir);
  } catch {
    return 0;
  }

  let deleted = 0;
  for (const name of entries) {
    if (name === '.gitignore') continue;
    const filePath = join(mediaDir, name);
    try {
      const info = lstatSync(filePath);
      if (!info.isFile()) continue;
      if (info.mtimeMs < cutoff) {
        unlinkSync(filePath);
        deleted += 1;
      }
    } catch {
      // Skip files concurrently removed or inaccessible
    }
  }

  return deleted;
}
