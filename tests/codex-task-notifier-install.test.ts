import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

describe('codex-task-notifier installer', () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  it('installs idempotently while preserving unrelated marketplace and native config', () => {
    const home = mkdtempSync(join(tmpdir(), 'cli2im-plugin-home-'));
    homes.push(home);
    mkdirSync(join(home, '.agents/plugins'), { recursive: true });
    mkdirSync(join(home, '.codex'), { recursive: true });
    const marketplacePath = join(home, '.agents/plugins/marketplace.json');
    const nativeConfigPath = join(home, '.codex/config.toml');
    writeFileSync(marketplacePath, JSON.stringify({
      name: 'personal', interface: { displayName: 'Personal' }, plugins: [{
        name: 'existing', source: { source: 'local', path: './plugins/existing' },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity',
      }],
    }));
    writeFileSync(nativeConfigPath, 'notify = ["native"]\n[tui]\nnotifications = ["agent-turn-complete"]\n');
    const script = join(process.cwd(), 'scripts/install-codex-task-notifier.sh');

    const dryRun = spawnSync('bash', [script, '--dry-run'], {
      cwd: process.cwd(), env: { ...process.env, HOME: home }, encoding: 'utf8',
    });
    expect(dryRun.status).toBe(0);
    expect(existsSync(join(home, 'plugins'))).toBe(false);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = spawnSync('bash', [script], {
        cwd: process.cwd(), env: { ...process.env, HOME: home }, encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).not.toContain('native');
    }

    const marketplace = JSON.parse(readFileSync(marketplacePath, 'utf8'));
    expect(marketplace.plugins.map((plugin: any) => plugin.name)).toEqual([
      'existing', 'codex-task-notifier',
    ]);
    const notifier = marketplace.plugins[1];
    expect(notifier.source.path).toMatch(/^\.\/plugins\/codex-task-notifier-/);
    const installedPath = join(home, notifier.source.path.slice(2));
    expect(existsSync(join(installedPath, '.codex-plugin/plugin.json'))).toBe(true);
    expect((statSync(installedPath).mode & 0o777)).toBe(0o700);
    expect((statSync(marketplacePath).mode & 0o777)).toBe(0o600);
    expect(readFileSync(nativeConfigPath, 'utf8')).toContain('agent-turn-complete');
    expect(existsSync(join(home, '.cli2im/backups/codex-task-notifier/rollback.json'))).toBe(true);
  });
});
