import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig, substituteEnvVars } from '../src/config/loader.js';
import { writeFileSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('substituteEnvVars', () => {
  it('replaces ${VAR} with env value', () => {
    const result = substituteEnvVars('id: ${MY_APP_ID}', { MY_APP_ID: 'abc123' });
    expect(result).toBe('id: abc123');
  });

  it('leaves unmatched ${VAR} as empty string', () => {
    const result = substituteEnvVars('token: ${MISSING_VAR}', {});
    expect(result).toBe('token: ');
  });

  it('handles multiple vars in one line', () => {
    const result = substituteEnvVars('${A}:${B}', { A: 'x', B: 'y' });
    expect(result).toBe('x:y');
  });
});

describe('loadConfig', () => {
  const tmpDir = join(tmpdir(), 'cli2im-test-config');

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads and parses yaml config with env substitution', () => {
    const yaml = `
bots:
  ccbot:
    agent: claude-code
    platform: feishu
    feishu:
      appId: \${TEST_APP_ID}
      appSecret: \${TEST_APP_SECRET}
    workingDirectory: ~/projects
    allowFrom:
      - ou_xxxx
    permissionMode: blacklist
agents:
  claude-code:
    binary: /usr/local/bin/claude
session:
  maxActive: 64
  idleResetMinutes: 120
  dbPath: ~/.cli2im/cli2im.db
dangerousPatterns:
  - 'rm\\s+-rf'
streaming:
  intervalMs: 200
  minDeltaChars: 30
  highWaterMark: 1048576
server:
  port: 3900
  host: 127.0.0.1
  token: \${CLI2IM_WEB_TOKEN}
newMessageBehavior: queue
`;
    const configPath = join(tmpDir, 'config.yaml');
    writeFileSync(configPath, yaml);

    const config = loadConfig(configPath, {
      TEST_APP_ID: 'cli_abc',
      TEST_APP_SECRET: 'secret123',
      CLI2IM_WEB_TOKEN: 'tok_xyz',
    });

    expect(config.bots.ccbot.feishu?.appId).toBe('cli_abc');
    expect(config.bots.ccbot.feishu?.appSecret).toBe('secret123');
    expect(config.bots.ccbot.agent).toBe('claude-code');
    expect(config.server.token).toBe('tok_xyz');
    expect(config.dangerousPatterns).toEqual(['rm\\s+-rf']);
    expect(config.session.maxActive).toBe(64);
  });

  it('loads new phase 2 config fields', () => {
    const yaml = `
bots:
  tgbot:
    agent: claude-code
    platform: telegram
    telegram:
      token: tg_token
    workingDirectory: ~/projects
    allowFrom: []
    permissionMode: blacklist
    larkCliConfigDir: ~/.lark-cli-ccbot
    autoApprove: true
    turnTimeoutMs: 600000
    idleTimeoutMs: 300000
    requireMention: true
    groupPolicy: allowlist
    groupAllowFrom:
      - oc_group
    userOverrides:
      ou_user:
        workingDirectory: ~/projects/user
    sandboxMode: workspace-write
agents:
  claude-code:
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
contentGuard:
  enabled: true
  blockThreshold: 15
`;
    const configPath = join(tmpDir, 'phase2.yaml');
    writeFileSync(configPath, yaml);

    const config = loadConfig(configPath);

    expect(config.bots.tgbot.telegram?.token).toBe('tg_token');
    expect(config.bots.tgbot.autoApprove).toBe(true);
    expect(config.bots.tgbot.groupPolicy).toBe('allowlist');
    expect(config.bots.tgbot.groupAllowFrom).toEqual(['oc_group']);
    expect(config.bots.tgbot.userOverrides?.ou_user.workingDirectory).toBe('~/projects/user');
    expect(config.bots.tgbot.sandbox).toBe('workdir');
    expect(config.contentGuard).toEqual({ enabled: true, blockThreshold: 15 });
  });

  it('defaults bot sandbox to workdir and realpaths global sandbox extra roots', () => {
    const extraRoot = join(tmpDir, 'extra-root');
    mkdirSync(extraRoot);
    const yaml = `
bots:
  ccbot:
    agent: claude-code
    platform: feishu
    feishu:
      appId: cli_abc
      appSecret: secret123
    workingDirectory: ${tmpDir}
    allowFrom: []
    permissionMode: bypass
sandboxExtraRoots:
  - ${extraRoot}
agents:
  claude-code:
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
`;
    const configPath = join(tmpDir, 'sandbox-default.yaml');
    writeFileSync(configPath, yaml);

    const config = loadConfig(configPath);

    expect(config.bots.ccbot.sandbox).toBe('workdir');
    expect(config.sandboxExtraRoots).toEqual([realpathSync(extraRoot)]);
  });

  it('rejects invalid sandbox values and dangerous extra roots', () => {
    const invalidSandbox = `
bots:
  ccbot:
    agent: claude-code
    platform: feishu
    feishu:
      appId: cli_abc
      appSecret: secret123
    workingDirectory: ~/projects
    allowFrom: []
    permissionMode: bypass
    sandbox: loose
agents:
  claude-code:
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
`;
    const invalidSandboxPath = join(tmpDir, 'invalid-sandbox.yaml');
    writeFileSync(invalidSandboxPath, invalidSandbox);
    expect(() => loadConfig(invalidSandboxPath)).toThrow(
      'Config error: bot "ccbot" sandbox must be "workdir" or "off"',
    );

    const rootExtra = invalidSandbox.replace('    sandbox: loose\n', 'sandboxExtraRoots:\n  - /\n');
    const rootExtraPath = join(tmpDir, 'root-extra.yaml');
    writeFileSync(rootExtraPath, rootExtra);
    expect(() => loadConfig(rootExtraPath)).toThrow(
      'Config error: sandboxExtraRoots must not include /',
    );

    for (const root of ['/private', '/System', '/Library', '/Applications', '/Volumes']) {
      const configPath = join(tmpDir, `dangerous-extra-${root.slice(1).toLowerCase()}.yaml`);
      writeFileSync(
        configPath,
        invalidSandbox.replace('    sandbox: loose\n', `sandboxExtraRoots:\n  - ${root}\n`),
      );
      expect(() => loadConfig(configPath)).toThrow(
        `Config error: sandboxExtraRoots must not include ${root}`,
      );
    }
  });

  it('validates new phase 2 config fields', () => {
    const yaml = `
bots:
  ccbot:
    agent: claude-code
    platform: feishu
    feishu:
      appId: cli_abc
      appSecret: secret123
    workingDirectory: ~/projects
    allowFrom: []
    permissionMode: blacklist
    turnTimeoutMs: 0
agents:
  claude-code:
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
`;
    const configPath = join(tmpDir, 'invalid-phase2.yaml');
    writeFileSync(configPath, yaml);

    expect(() => loadConfig(configPath)).toThrow(
      'Config error: bot "ccbot" turnTimeoutMs must be a positive number',
    );
  });

  it('throws on missing config file', () => {
    expect(() => loadConfig('/nonexistent/config.yaml')).toThrow();
  });
});
