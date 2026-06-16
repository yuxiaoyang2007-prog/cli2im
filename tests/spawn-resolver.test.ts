import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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
