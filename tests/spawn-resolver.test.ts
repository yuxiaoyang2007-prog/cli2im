import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/loader.js';
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

  it('passes valid ACK tuning into spawn opts and rejects invalid ACK tuning', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'cli2im-spawn-resolver-'));
    const configPath = join(configDir, 'config.yaml');
    await writeFile(configPath, `
bots:
  ccbot:
    agent: claude-code-pty
    platform: feishu
    feishu:
      appId: cli_abc
      appSecret: secret
    workingDirectory: ${process.cwd()}
    allowFrom: []
    permissionMode: bypass
    ackWindowMs: 1500
    maxInjectRetries: 4
agents:
  claude-code-pty:
    binary: /usr/local/bin/claude
session:
  maxActive: 64
  idleResetMinutes: 120
  dbPath: ~/.cli2im/cli2im.db
dangerousPatterns: []
streaming:
  intervalMs: 200
  minDeltaChars: 30
  highWaterMark: 1048576
server:
  port: 3900
  host: 127.0.0.1
  token: tok_xyz
newMessageBehavior: queue
`);
    const config = loadConfig(configPath);
    const opts = await resolveBotSpawnOpts({
      botConfig: config.bots.ccbot,
      workingDirectory: config.bots.ccbot.workingDirectory,
    });

    expect(opts.ackWindowMs).toBe(1_500);
    expect(opts.maxInjectRetries).toBe(4);

    for (const [field, value] of [
      ['ackWindowMs', 0],
      ['ackWindowMs', 1.5],
      ['ackWindowMs', Number.POSITIVE_INFINITY],
      ['maxInjectRetries', -1],
      ['maxInjectRetries', 2.5],
      ['maxInjectRetries', '3'],
    ] as const) {
      await expect(resolveBotSpawnOpts({
        botConfig: botConfig({ [field]: value } as Partial<BotConfig>),
        workingDirectory: process.cwd(),
      })).rejects.toThrow(`Config error: bot ${field} must be a positive integer`);
    }
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

  it('drops broad/ancestor other-protected roots so a sibling bot at home cannot deny the PTY bot', async () => {
    // Regression: collectOtherProtectedRoots gathers every other bot's workdir. A sibling
    // codex/agy bot running in home would otherwise put ~ into a PTY bot's protected roots,
    // making the profile deny the whole home tree -> the PTY bot can't access its own workdir.
    const projectReal = await realpath(process.cwd());
    const narrowReal = await realpath(join(projectReal, 'tests'));
    const homeReal = await realpath(homedir());
    const opts = await resolveBotSpawnOpts({
      botConfig: botConfig(),
      workingDirectory: projectReal,
      otherProtectedRoots: [homedir(), '/tmp', join(projectReal, 'tests')],
    });
    const protectedRoots = opts.sandboxOtherProtectedRoots ?? [];
    expect(protectedRoots).not.toContain(homeReal);  // broad/ancestor dropped
    expect(protectedRoots).not.toContain('/tmp');     // outside user home trees dropped
    expect(protectedRoots).toContain(narrowReal);     // safe narrow root kept
    expect(opts.sandboxBoxRoots).toEqual([projectReal]);
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
