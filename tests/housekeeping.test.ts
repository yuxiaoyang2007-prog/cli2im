import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pruneStaleMediaFiles, rotateLogFileIfNeeded } from '../src/util/housekeeping.js';

describe('Housekeeping utilities', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length > 0) {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });

  function makeDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'cli2im-housekeeping-'));
    dirs.push(dir);
    return dir;
  }

  it('copy-truncates oversized log files while preserving inode and 0600 permissions', () => {
    const dir = makeDir();
    const logPath = join(dir, 'cli2im.log');

    writeFileSync(logPath, 'small', { mode: 0o644 });
    expect(rotateLogFileIfNeeded(logPath, { maxBytes: 100 })).toBe(false);

    const inodeBefore = statSync(logPath).ino;
    writeFileSync(logPath, 'A'.repeat(120));
    expect(rotateLogFileIfNeeded(logPath, { maxBytes: 100, maxBackups: 2 })).toBe(true);

    expect(statSync(logPath).ino).toBe(inodeBefore);
    expect(statSync(logPath).size).toBe(0);
    expect(statSync(logPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(`${logPath}.1`, 'utf8')).toBe('A'.repeat(120));
    expect(statSync(`${logPath}.1`).mode & 0o777).toBe(0o600);

    // Rotate a second time to verify backup shifting
    writeFileSync(logPath, 'B'.repeat(150));
    expect(rotateLogFileIfNeeded(logPath, { maxBytes: 100, maxBackups: 2 })).toBe(true);
    expect(readFileSync(`${logPath}.1`, 'utf8')).toBe('B'.repeat(150));
    expect(readFileSync(`${logPath}.2`, 'utf8')).toBe('A'.repeat(120));
    expect(statSync(`${logPath}.2`).mode & 0o777).toBe(0o600);
  });

  it('prunes only stale regular files in mediaDir while keeping .gitignore, recent files, subdirs, and symlinks', () => {
    const dir = makeDir();
    const now = 1_800_000_000_000;
    const oldDate = new Date(now - 20 * 24 * 3600_000);
    const freshDate = new Date(now - 2 * 24 * 3600_000);

    const gitignore = join(dir, '.gitignore');
    const oldImg = join(dir, 'old.png');
    const freshImg = join(dir, 'fresh.png');
    const subDir = join(dir, 'nested');
    const symlinkTarget = join(dir, 'keep-target.txt');
    const staleSymlink = join(dir, 'link.png');

    writeFileSync(gitignore, '*\n');
    utimesSync(gitignore, oldDate, oldDate);

    writeFileSync(oldImg, 'old');
    utimesSync(oldImg, oldDate, oldDate);

    writeFileSync(freshImg, 'fresh');
    utimesSync(freshImg, freshDate, freshDate);

    mkdirSync(subDir);
    writeFileSync(symlinkTarget, 'keep');
    utimesSync(symlinkTarget, freshDate, freshDate);
    symlinkSync(symlinkTarget, staleSymlink);

    const deleted = pruneStaleMediaFiles(dir, { now, maxAgeMs: 14 * 24 * 3600_000 });
    expect(deleted).toBe(1);
    expect(existsSync(oldImg)).toBe(false);
    expect(existsSync(freshImg)).toBe(true);
    expect(existsSync(gitignore)).toBe(true);
    expect(existsSync(subDir)).toBe(true);
    expect(existsSync(staleSymlink)).toBe(true);
  });
});
