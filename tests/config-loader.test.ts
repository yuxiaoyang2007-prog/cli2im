import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig, loadRuntimeConfig, substituteEnvVars } from '../src/config/loader.js';
import { writeFileSync, mkdirSync, rmSync, realpathSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AppConfig } from '../src/types.js';
import { stringify } from 'yaml';

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

  function loadNotificationFixture(notificationYaml: string): AppConfig {
    const configPath = join(tmpDir, `notifications-${Date.now()}.yaml`);
    writeFileSync(configPath, `
bots:
  codexbot:
    agent: codex
    platform: feishu
    feishu: { appId: app, appSecret: secret }
    workingDirectory: /tmp/project
    allowFrom: [ou_user]
    permissionMode: blacklist
  telegrambot:
    agent: codex
    platform: telegram
    telegram: { token: telegram-test-token }
    workingDirectory: /tmp/project
    allowFrom: [test-user]
    permissionMode: blacklist
agents:
  codex: { binary: /opt/homebrew/bin/codex }
session: { maxActive: 64, idleResetMinutes: 120, dbPath: /tmp/cli2im.db }
dangerousPatterns: []
streaming: { intervalMs: 200, minDeltaChars: 30, highWaterMark: 1048576 }
server: { port: 3900, host: 127.0.0.1, token: test }
newMessageBehavior: queue
${notificationYaml}
`);
    return loadConfig(configPath);
  }

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function loadAccessFixture(botChanges: Record<string, unknown> = {}, topLevelChanges: Record<string, unknown> = {}): AppConfig {
    const fixture = {
      bots: { testbot: { agent: 'codex', platform: 'telegram', telegram: { token: 'test-token' },
        workingDirectory: tmpDir, allowFrom: ['user'], permissionMode: 'blacklist', ...botChanges } },
      agents: { codex: { binary: '/usr/local/bin/codex' } },
      server: { host: '127.0.0.1', port: 3900, token: 'test-token' }, dangerousPatterns: [],
      ...topLevelChanges,
    };
    const path = join(tmpDir, 'access-config.yaml');
    writeFileSync(path, stringify(fixture));
    return loadConfig(path);
  }

  it('F04 defaults omitted permissionMode to blacklist', () => {
    expect(loadAccessFixture({ permissionMode: undefined }).bots.testbot.permissionMode).toBe('blacklist');
  });

  it('loads explicit access grants and operational settings', () => {
    const result = loadAccessFixture({ enabled: true, adminUsers: [123, 'user'], allowPublic: false,
      sessionRoots: [tmpDir], projects: { demo: tmpDir }, shortcuts: { review: { prompt: 'Review current changes', description: 'Review' } },
      debounceMs: 1000, speech: { stt: true, tts: false }, relay: { enabled: true, allowFromBots: ['trusted'] } },
    { network: { mode: 'system', required: true, noProxy: ['localhost', '127.0.0.1'] } });
    expect(result.bots.testbot.adminUsers).toEqual(['123', 'user']);
    expect(result.bots.testbot.sessionRoots).toEqual([realpathSync(tmpDir)]);
    expect(result.network?.required).toBe(true);
  });

  it.each([
    { enabled: 'yes' }, { allowPublic: 'yes' }, { allowFrom: 'user' }, { adminUsers: ['*'] },
    { groupAllowFrom: ['*'] }, { sessionRoots: ['/'] }, { debounceMs: -1 }, { debounceMs: '100' },
    { projects: { test: 3 } }, { shortcuts: { test: { prompt: '' } } }, { speech: { tts: 'yes' } },
    { relay: { enabled: true, allowFromBots: ['*'] } },
  ])('rejects invalid access and operational config %j', (changes) => {
    expect(() => loadAccessFixture(changes)).toThrow();
  });

  it('keeps empty and legacy wildcard lists parseable without granting public access', () => {
    expect(loadAccessFixture({ allowFrom: [] }).bots.testbot.allowFrom).toEqual([]);
    expect(loadAccessFixture({ allowFrom: ['*'] }).bots.testbot.allowPublic).toBeUndefined();
  });

  it.each([
    { mode: 'direct', required: true }, { mode: 'system', required: 'yes' },
    { mode: 'system', required: true, noProxy: 'localhost' },
  ])('rejects malformed network config %j', (network) => {
    expect(() => loadAccessFixture({}, { network })).toThrow('Config error: network');
  });

  it('isolates an invalid bot at runtime while retaining strict validation and source bytes', () => {
    const valid = loadAccessFixture();
    const path = join(tmpDir, 'runtime-config.yaml');
    writeFileSync(path, stringify({ ...valid, bots: {
      ...valid.bots, broken: { ...valid.bots.testbot, telegram: { token: '' }, adminUsers: ['secret-user'] },
      malformed: null,
    } }));
    const before = readFileSync(path, 'utf8');
    expect(() => loadConfig(path)).toThrow('missing telegram token');
    const { config, botErrors } = loadRuntimeConfig(path);
    expect(Object.keys(config.bots)).toEqual(['testbot']);
    expect(botErrors).toEqual({ broken: 'Invalid bot configuration', malformed: 'Invalid bot configuration' });
    expect(JSON.stringify(botErrors)).not.toContain('secret-user');
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('disables notification delivery to an isolated bot without breaking healthy bots', () => {
    const valid = loadAccessFixture();
    const path = join(tmpDir, 'runtime-notifications.yaml');
    writeFileSync(path, stringify({ ...valid, bots: { ...valid.bots,
      broken: { ...valid.bots.testbot, platform: 'feishu', feishu: { appId: 'app', appSecret: '' } } },
    notifications: { codex: { enabled: true, botName: 'broken', completionSource: 'structured' } } }));
    const { config, botErrors } = loadRuntimeConfig(path);
    expect(config.notifications?.codex.enabled).toBe(false);
    expect(config.bots.testbot).toBeDefined();
    expect(config.bots.broken).toBeUndefined();
    expect(botErrors.broken).toBe('Invalid bot configuration');
  });

  it('runtime tolerance does not mask invalid global config', () => {
    const valid = loadAccessFixture();
    const path = join(tmpDir, 'runtime-global.yaml');
    writeFileSync(path, stringify({ ...valid, server: { port: 3900 } }));
    expect(() => loadRuntimeConfig(path)).toThrow('server.token');
  });

  it('does not include YAML source or secret values in parse errors', () => {
    const path = join(tmpDir, 'runtime-yaml.yaml');
    writeFileSync(path, 'bots: [private-secret');
    expect(() => loadRuntimeConfig(path)).toThrow('Config error: invalid YAML');
    try { loadRuntimeConfig(path); } catch (error) { expect(String(error)).not.toContain('private-secret'); }
  });

  it('accepts a valid Codex notification config', () => {
    const config = loadNotificationFixture(`
notifications:
  codex:
    enabled: true
    botName: codexbot
    completionSource: structured
`);
    expect(config.notifications?.codex).toEqual({
      enabled: true, botName: 'codexbot', completionSource: 'structured',
    });
  });

  it('keeps the sample config internally valid for Codex notifications', () => {
    const config = loadConfig(join(process.cwd(), 'config.example.yaml'), {
      CCBOT_FEISHU_APP_ID: 'cc-app',
      CCBOT_FEISHU_APP_SECRET: 'cc-secret',
      CODEXBOT_FEISHU_APP_ID: 'codex-app',
      CODEXBOT_FEISHU_APP_SECRET: 'codex-secret',
      CLI2IM_WEB_TOKEN: 'server-token',
      PATH: '/usr/bin',
    });

    expect(config.notifications?.codex.botName).toBe('codexbot');
    expect(config.bots.codexbot.platform).toBe('feishu');
  });

  it.each([
    ['enabled', 'yes'],
    ['botName', ''],
  ])('rejects invalid notifications.codex.%s', (field, value) => {
    expect(() => loadNotificationFixture(`
notifications:
  codex:
    enabled: ${field === 'enabled' ? value : 'true'}
    botName: ${field === 'botName' ? JSON.stringify(value) : 'codexbot'}
`)).toThrow('Config error: notifications.codex');
  });

  it('defaults the Codex completion source to legacy and rejects unknown modes', () => {
    const legacy = loadNotificationFixture(`
notifications:
  codex:
    enabled: true
    botName: codexbot
`);
    expect(legacy.notifications?.codex.completionSource).toBe('legacy');
    expect(() => loadNotificationFixture(`
notifications:
  codex:
    enabled: true
    botName: codexbot
    completionSource: heuristic
`)).toThrow('Config error: notifications.codex.completionSource');
  });

  it('rejects a Codex notification bot name that does not exist', () => {
    expect(() => loadNotificationFixture(`
notifications:
  codex:
    enabled: true
    botName: missingbot
`)).toThrow('Config error: notifications.codex.botName must name an existing bot');
  });

  it('rejects a Codex notification bot that does not use Feishu', () => {
    expect(() => loadNotificationFixture(`
notifications:
  codex:
    enabled: true
    botName: telegrambot
`)).toThrow('Config error: notifications.codex.botName must use the feishu platform');
  });

  it.each([
    ['an empty notifications object', 'notifications: {}'],
    ['a null notifications.codex value', 'notifications:\n  codex: null'],
  ])('rejects %s', (_case, notificationYaml) => {
    expect(() => loadNotificationFixture(notificationYaml)).toThrow(
      'Config error: notifications.codex must be an object',
    );
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
