import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveBotSpawnOpts } from '../src/index.js';
import type { BotConfig } from '../src/types.js';

describe('resolveBotSpawnOpts', () => {
  it('defaults sandbox to workdir and returns strict realpath box roots', async () => {
    const root = process.cwd();
    const workDir = root;
    const extraRoot = join(root, 'src');
    const inbox = join(workDir, 'tests');
    const workDirReal = await realpath(workDir);
    const extraRootReal = await realpath(extraRoot);
    const inboxReal = await realpath(inbox);

    const opts = await resolveBotSpawnOpts({
      botConfig: botConfig(),
      workingDirectory: workDirReal,
      sandboxExtraRoots: [extraRoot],
      addDirs: [inbox],
      env: { FOO: 'bar' },
      model: 'sonnet',
      reasoningEffort: 'high',
      initialPrompt: 'hello',
    });

    expect(opts).toMatchObject({
      workingDirectory: workDirReal,
      permissionMode: 'bypass',
      env: { FOO: 'bar' },
      model: 'sonnet',
      reasoningEffort: 'high',
      initialPrompt: 'hello',
      sandbox: 'workdir',
      sandboxBoxRoots: [workDirReal, extraRootReal],
      addDirs: [inboxReal],
    });
  });

  it('does not set sandbox box roots when sandbox is off', async () => {
    const opts = await resolveBotSpawnOpts({
      botConfig: botConfig({ sandbox: 'off' }),
      workingDirectory: process.cwd(),
    });

    expect(opts.sandbox).toBe('off');
    expect(opts.sandboxBoxRoots).toBeUndefined();
  });

  it('fails closed when an add-dir resolves outside the sandbox box roots', async () => {
    const root = process.cwd();
    const workDir = join(root, 'src');
    const outside = join(root, 'tests');
    const outsideReal = await realpath(outside);

    await expect(resolveBotSpawnOpts({
      botConfig: botConfig(),
      workingDirectory: workDir,
      addDirs: [outside],
    })).rejects.toThrow(`Sandbox add-dir outside box roots: ${outsideReal}`);
  });

  it.each([
    ['home directory', homedir()],
    ['/Users ancestor', '/Users'],
    ['filesystem root', '/'],
  ])('rejects unsafe sandbox workdir box root: %s', async (_label, root) => {
    const rootReal = await realpath(root);

    await expect(resolveBotSpawnOpts({
      botConfig: botConfig(),
      workingDirectory: root,
    })).rejects.toThrow(`Unsafe sandbox box root: ${rootReal}`);
  });

  it.each([
    ['claude config root', join(homedir(), '.claude')],
    ['claude hooks subtree', join(homedir(), '.claude', 'hooks')],
    ['ssh config subtree', join(homedir(), '.ssh')],
  ])('rejects protected sandbox workdir box root: %s', async (_label, root) => {
    const rootReal = await realpath(root);

    await expect(resolveBotSpawnOpts({
      botConfig: botConfig(),
      workingDirectory: root,
    })).rejects.toThrow(`Unsafe sandbox box root: ${rootReal}`);
  });

  it('rejects protected sandbox extra roots', async () => {
    const claudeRoot = join(homedir(), '.claude');
    const claudeRootReal = await realpath(claudeRoot);

    await expect(resolveBotSpawnOpts({
      botConfig: botConfig(),
      workingDirectory: process.cwd(),
      sandboxExtraRoots: [claudeRoot],
    })).rejects.toThrow(`Unsafe sandbox box root: ${claudeRootReal}`);
  });

  it.each([
    ['/tmp', '/tmp'],
    ['/etc', '/etc'],
  ])('rejects sandbox extra root outside user home trees: %s', async (_label, root) => {
    const rootReal = await realpath(root);

    await expect(resolveBotSpawnOpts({
      botConfig: botConfig(),
      workingDirectory: process.cwd(),
      sandboxExtraRoots: [root],
    })).rejects.toThrow(`Unsafe sandbox box root: ${rootReal}`);
  });

  it('does NOT sandbox non-pty agents (codex) even with a home workdir or explicit sandbox', async () => {
    // Regression: sandbox must only apply to claude-code-pty. codexbot's workdir is home
    // (/Users/<user>); if the box-root check ran for it, resolveBotSpawnOpts would throw
    // "Unsafe sandbox box root" and break the bot.
    const opts = await resolveBotSpawnOpts({
      botConfig: botConfig({ agent: 'codex', sandbox: 'workdir' }),
      workingDirectory: homedir(),
    });
    expect(opts.sandbox).toBe('off');
    expect(opts.sandboxBoxRoots).toBeUndefined();
  });

  it('accepts a normal project directory under home as a box root', async () => {
    const projectReal = await realpath(process.cwd());

    await expect(resolveBotSpawnOpts({
      botConfig: botConfig(),
      workingDirectory: projectReal,
    })).resolves.toMatchObject({
      sandbox: 'workdir',
      sandboxBoxRoots: [projectReal],
    });
  });
});

function botConfig(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    agent: 'claude-code-pty',
    platform: 'feishu',
    feishu: { appId: 'cli_abc', appSecret: 'secret' },
    workingDirectory: '/unused',
    allowFrom: [],
    permissionMode: 'bypass',
    ...overrides,
  };
}
