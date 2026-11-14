import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDataDirDotEnv } from '../src/config/dotenv.js';

const tempDirs: string[] = [];
const originalSkip = process.env.CLI2IM_SKIP_DOTENV;
const originalDataDir = process.env.CLI2IM_DATA_DIR;

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cli2im-dotenv-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  if (originalSkip === undefined) delete process.env.CLI2IM_SKIP_DOTENV;
  else process.env.CLI2IM_SKIP_DOTENV = originalSkip;

  if (originalDataDir === undefined) delete process.env.CLI2IM_DATA_DIR;
  else process.env.CLI2IM_DATA_DIR = originalDataDir;

  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('loadDataDirDotEnv', () => {
  it('parses KEY=VALUE, export prefix, matching quotes, and ignores comments without overwriting existing keys', () => {
    const dir = makeTempDir();
    const envPath = join(dir, '.env');
    writeFileSync(
      envPath,
      [
        '# comment',
        '',
        'PLAIN=abc123',
        'export EXPORTED=from_export # inline comment',
        "SINGLE='hello # world'",
        'DOUBLE="line1\\nline2"',
        'EMPTY=',
        'EXISTING=from_file',
      ].join('\n'),
      'utf8',
    );
    chmodSync(envPath, 0o644);

    const targetEnv: NodeJS.ProcessEnv = { EXISTING: 'keep_me' };
    const count = loadDataDirDotEnv(envPath, targetEnv);

    expect(count).toBe(5);
    expect(targetEnv.PLAIN).toBe('abc123');
    expect(targetEnv.EXPORTED).toBe('from_export');
    expect(targetEnv.SINGLE).toBe('hello # world');
    expect(targetEnv.DOUBLE).toBe('line1\nline2');
    expect(targetEnv.EMPTY).toBe('');
    expect(targetEnv.EXISTING).toBe('keep_me');
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
  });

  it('rejects symlinks and directories, and returns 0 when file does not exist', () => {
    const dir = makeTempDir();
    const realFile = join(dir, 'real.env');
    writeFileSync(realFile, 'SECRET=should_not_load\n', 'utf8');

    const symlinkPath = join(dir, 'link.env');
    symlinkSync(realFile, symlinkPath);

    const subdir = join(dir, 'dir.env');
    mkdirSync(subdir);

    const envA: NodeJS.ProcessEnv = {};
    expect(loadDataDirDotEnv(symlinkPath, envA)).toBe(0);
    expect(envA.SECRET).toBeUndefined();

    const envB: NodeJS.ProcessEnv = {};
    expect(loadDataDirDotEnv(subdir, envB)).toBe(0);

    expect(loadDataDirDotEnv(join(dir, 'missing.env'), {})).toBe(0);
  });

  it('skips loading when CLI2IM_SKIP_DOTENV=1 and resolves default path from CLI2IM_DATA_DIR', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, '.env'), 'FOO=bar\n', { mode: 0o600 });
    process.env.CLI2IM_DATA_DIR = dir;

    const skippedEnv: NodeJS.ProcessEnv = { CLI2IM_SKIP_DOTENV: '1' };
    expect(loadDataDirDotEnv(undefined, skippedEnv)).toBe(0);
    expect(skippedEnv.FOO).toBeUndefined();

    const loadedEnv: NodeJS.ProcessEnv = {};
    expect(loadDataDirDotEnv(undefined, loadedEnv)).toBe(1);
    expect(loadedEnv.FOO).toBe('bar');
  });

  it('overwrites existing keys only when overwrite option is enabled', () => {
    const dir = makeTempDir();
    const envPath = join(dir, '.env');
    writeFileSync(envPath, 'TOKEN=new_val\n', { mode: 0o600 });

    const targetEnv: NodeJS.ProcessEnv = { TOKEN: 'old_val' };
    expect(loadDataDirDotEnv(envPath, targetEnv)).toBe(0);
    expect(targetEnv.TOKEN).toBe('old_val');

    expect(loadDataDirDotEnv(envPath, targetEnv, { overwrite: true })).toBe(1);
    expect(targetEnv.TOKEN).toBe('new_val');
  });
});
