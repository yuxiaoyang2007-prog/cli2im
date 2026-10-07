import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/types.js';
import { buildServiceInventory, formatDoctorReport, runDoctor } from '../src/services/doctor.js';

function config(): AppConfig {
  return {
    bots: {
      alice: { agent: 'codex', platform: 'feishu', workingDirectory: '/project', allowFrom: ['user'], permissionMode: 'blacklist', feishu: { appId: 'secret-app-id', appSecret: 'secret-app-value' }, speech: { stt: true, tts: false } },
      unused: { agent: 'zcode', platform: 'telegram', workingDirectory: '/project', allowFrom: [], permissionMode: 'blacklist', enabled: false },
    },
    agents: { codex: { binary: '/secret/local/path', env: { API_KEY: 'secret-api-value', NO_PROXY: 'deepseek.com,minimax.io' } }, zcode: { binary: 'zcode' } },
    session: { maxActive: 10, idleResetMinutes: 30, dbPath: '/secret/db' },
    dangerousPatterns: [], streaming: { intervalMs: 200, minDeltaChars: 30, highWaterMark: 1024 },
    server: { host: '127.0.0.1', port: 3900, token: 'secret-server-token' }, newMessageBehavior: 'queue', contentGuard: { enabled: true },
  };
}

describe('truthful local diagnostics', () => {
  it('never turns successful binary preflight into proof of login or remote connectivity', async () => {
    const preflight = vi.fn(async () => ({ ok: true, version: 'version secret-api-value' }));
    const report = await runDoctor({ config: config(), getPlugin: () => ({ preflight }), lifecycle: [{ name: 'alice', state: 'running', enabled: true, acceptsMessages: true }], speechKeyConfigured: true, activeTasks: 0, contentGuard: 'unavailable' });
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(report.checks.find((check) => check.key === 'agent:codex')?.state).toBe('ok');
    expect(report.checks.find((check) => check.key === 'login:codex')?.state).toBe('unknown');
    expect(report.checks.find((check) => check.key === 'bot:alice')?.detail).toContain('不能证明远端');
    expect(report.checks.find((check) => check.key === 'content-guard')?.state).toBe('warning');
    expect(report.checks.find((check) => check.key === 'active-tasks')?.detail).toBe('0 个');
    expect(JSON.stringify(report)).not.toContain('secret-');
  });

  it('keeps unknown states unknown and suppresses errors containing secrets', async () => {
    const report = await runDoctor({ config: config(), getPlugin: () => ({ preflight: async () => { throw new Error('secret-api-value'); } }), speechKeyConfigured: false });
    expect(report.checks.find((check) => check.key === 'network')?.state).toBe('unknown');
    expect(report.checks.find((check) => check.key === 'active-tasks')?.state).toBe('unknown');
    expect(report.checks.find((check) => check.key === 'bot:unused')?.state).toBe('off');
    expect(formatDoctorReport(report)).not.toContain('secret-api-value');
    expect(formatDoctorReport(report)).toContain('[未验证]');
  });

  it('inventories enabled integration flows without treating proxy exceptions as AI providers', () => {
    const inventory = buildServiceInventory(config());
    expect(inventory.map((entry) => entry.service)).toEqual(['飞书 / Lark', 'codex 所配置的模型服务', 'DashScope 语音识别']);
    expect(JSON.stringify(inventory)).not.toMatch(/deepseek|minimax|secret-|zcode|Telegram/);
    expect(inventory.at(-1)?.data).toBe('用户发送的完整语音文件');
  });

  it('reflects both speech switches and disabled guard without claiming service availability', async () => {
    const settings = config();
    settings.bots.alice.speech = { stt: false, tts: false };
    settings.contentGuard = { enabled: false };
    const report = await runDoctor({ config: settings, speechKeyConfigured: true, contentGuard: 'active' });
    expect(report.checks.find((check) => check.key === 'speech:alice')?.state).toBe('off');
    expect(report.checks.find((check) => check.key === 'content-guard')?.state).toBe('off');
    expect(report.services.some((service) => service.service.includes('DashScope'))).toBe(false);
  });
});
