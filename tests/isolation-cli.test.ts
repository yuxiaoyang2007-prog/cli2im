import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe('slice 9 standalone CLI', () => {
  it('doctor isolation runs without a daemon and returns nonzero for no VERIFIED scope', () => {
    const root = mkdtempSync(resolve('tests/.isolation-cli-')); roots.push(root);
    const config = join(root, 'config.yaml');
    writeFileSync(config, JSON.stringify({ bots: {}, agents: {}, session: { dbPath: ':memory:' },
      server: { host: '127.0.0.1', port: 3900, token: 'fixture' }, dangerousPatterns: [] }));
    const child = spawnSync(process.execPath, ['--import', 'tsx', resolve('cli/cli2im.ts'), 'doctor', 'isolation', '--config', config], {
      encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, CLI2IM_DATA_DIR: join(root, 'bridge') },
    });
    expect(child.status, child.stderr).toBe(1);
    expect(child.stdout).toContain('未配置启用的隔离范围');
    expect(child.stderr).not.toContain('WEB_TOKEN');
    expect(child.stdout).not.toContain(root);
  });
});
