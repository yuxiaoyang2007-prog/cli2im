import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig, substituteEnvVars } from '../src/config/loader.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
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

  it('throws on missing config file', () => {
    expect(() => loadConfig('/nonexistent/config.yaml')).toThrow();
  });
});
