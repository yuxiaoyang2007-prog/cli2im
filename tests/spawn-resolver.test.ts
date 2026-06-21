import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveBotSpawnOpts } from '../src/index.js';
import type { BotConfig } from '../src/types.js';

describe('resolveBotSpawnOpts', () => {
  it('expands a ~-prefixed working directory to the home path', async () => {
    const opts = await resolveBotSpawnOpts({
      botConfig: botConfig(),
      workingDirectory: '~/project-a',
    });

    expect(opts.workingDirectory).toBe(join(homedir(), 'project-a'));
  });

  it('passes through spawn options unchanged', async () => {
    const opts = await resolveBotSpawnOpts({
      botConfig: botConfig({ permissionMode: 'blacklist' }),
      workingDirectory: process.cwd(),
      env: { FOO: 'bar' },
      model: 'sonnet',
      turnTimeoutMs: 600_000,
      idleTimeoutMs: 300_000,
      reasoningEffort: 'high',
      initialPrompt: 'hello',
    });

    expect(opts).toMatchObject({
      workingDirectory: process.cwd(),
      permissionMode: 'blacklist',
      env: { FOO: 'bar' },
      model: 'sonnet',
      turnTimeoutMs: 600_000,
      idleTimeoutMs: 300_000,
      reasoningEffort: 'high',
      initialPrompt: 'hello',
    });
  });

  it('returns no sandbox box-root fields', async () => {
    const opts = await resolveBotSpawnOpts({
      botConfig: botConfig(),
      workingDirectory: process.cwd(),
    });

    expect(opts.sandbox).toBeUndefined();
    expect(opts.sandboxBoxRoots).toBeUndefined();
  });

  describe('agentsFile (runtime instructions)', () => {
    let workDir: string;

    beforeEach(() => {
      workDir = mkdtempSync(join(tmpdir(), 'cli2im-agents-'));
    });

    afterEach(() => {
      rmSync(workDir, { recursive: true, force: true });
    });

    it('reads AGENTS.md from the working directory by default', async () => {
      writeFileSync(join(workDir, 'AGENTS.md'), '  Always respond in French.\n');

      const opts = await resolveBotSpawnOpts({
        botConfig: botConfig(),
        workingDirectory: workDir,
      });

      expect(opts.appendSystemPrompt).toBe('Always respond in French.');
    });

    it('leaves appendSystemPrompt undefined when no AGENTS.md exists', async () => {
      const opts = await resolveBotSpawnOpts({
        botConfig: botConfig(),
        workingDirectory: workDir,
      });

      expect(opts.appendSystemPrompt).toBeUndefined();
    });

    it('treats an empty AGENTS.md as no instructions', async () => {
      writeFileSync(join(workDir, 'AGENTS.md'), '   \n\n');

      const opts = await resolveBotSpawnOpts({
        botConfig: botConfig(),
        workingDirectory: workDir,
      });

      expect(opts.appendSystemPrompt).toBeUndefined();
    });

    it('honors a custom relative agentsFile path', async () => {
      writeFileSync(join(workDir, 'runtime.md'), 'Custom instructions.');

      const opts = await resolveBotSpawnOpts({
        botConfig: botConfig({ agentsFile: 'runtime.md' }),
        workingDirectory: workDir,
      });

      expect(opts.appendSystemPrompt).toBe('Custom instructions.');
    });

    it('disables the lookup when agentsFile is false', async () => {
      writeFileSync(join(workDir, 'AGENTS.md'), 'Should be ignored.');

      const opts = await resolveBotSpawnOpts({
        botConfig: botConfig({ agentsFile: false }),
        workingDirectory: workDir,
      });

      expect(opts.appendSystemPrompt).toBeUndefined();
    });
  });
});

function botConfig(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    agent: 'claude-code',
    platform: 'feishu',
    feishu: { appId: 'cli_abc', appSecret: 'secret' },
    workingDirectory: '/unused',
    allowFrom: [],
    permissionMode: 'bypass',
    ...overrides,
  };
}
