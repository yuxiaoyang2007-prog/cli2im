import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

describe('esbuild config failure handling', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('exits nonzero when esbuild rejects', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cli2im-esbuild-failure-'));
    directories.push(directory);
    const esbuildDir = join(directory, 'node_modules', 'esbuild');
    mkdirSync(esbuildDir, { recursive: true });
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(join(esbuildDir, 'package.json'), JSON.stringify({
      name: 'esbuild',
      type: 'module',
      exports: './index.js',
    }));
    writeFileSync(join(esbuildDir, 'index.js'), [
      "export async function build() {",
      "  throw new Error('synthetic build rejection');",
      '}',
    ].join('\n'));
    writeFileSync(
      join(directory, 'esbuild.config.mjs'),
      readFileSync(join(process.cwd(), 'esbuild.config.mjs'), 'utf8'),
    );

    const result = spawnSync(process.execPath, ['esbuild.config.mjs'], {
      cwd: directory,
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('synthetic build rejection');
  });
});
