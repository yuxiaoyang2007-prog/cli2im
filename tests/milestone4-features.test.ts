import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/session/store.js';
import { handleBridgeCommand } from '../src/commands/bridge-commands.js';
import { deliverCliNotification } from '../src/notifications/cli-notify.js';
import { selectDirectedRelayTargets } from '../src/relay/deliver.js';
import { formatOnlineDoctorSection, runOnlineDoctorProbes } from '../src/services/doctor-online.js';
import { formatTopReport, renderDashboardHtml } from '../src/services/dashboard.js';
import { HttpServer } from '../src/services/server.js';
import type { AppConfig, PlatformAdapter, SessionKey } from '../src/types.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cli2im-m4-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('Milestone 4 features', () => {
  it('supports /watch binding, status, removal, and cli-notify delivery with 1-click resume grant', async () => {
    const dir = process.cwd();
    const store = await SessionStore.create(':memory:');
    try {
      const send = vi.fn().mockResolvedValue('msg_1');
      const adapter = { name: 'telegram', send } as unknown as PlatformAdapter;
      const botConfig = {
        agent: 'agy',
        platform: 'telegram' as const,
        telegram: { token: 'tg-tok' },
        workingDirectory: dir,
        allowFrom: ['user_1'],
        permissionMode: 'blacklist' as const,
      };
      const config = {
        bots: { agy_tg: botConfig },
        agents: { agy: { binary: '/usr/bin/agy' } },
      } as unknown as AppConfig;
      const adapters = new Map<string, PlatformAdapter>([['agy_tg', adapter]]);
      const key = 'telegram:chat_1:agy_tg:topic_7' as SessionKey;

      await handleBridgeCommand(
        { command: 'watch', args: [] },
        key,
        'agy_tg',
        'chat_1',
        adapter,
        store,
        { getPlugin: () => ({ capabilities: { sessionResume: true } }) } as never,
        {} as never,
        undefined,
        undefined,
        new Map(),
        { fastModeBySession: new Map() },
        botConfig,
        { platform: 'telegram', chatType: 'private', userId: 'user_1', threadId: 'topic_7' },
      );

      const saved = await store.getWatchTarget('agy_tg');
      expect(saved).toMatchObject({
        botName: 'agy_tg',
        platform: 'telegram',
        chatId: 'chat_1',
        threadId: 'topic_7',
        userId: 'user_1',
      });

      const delivered = await deliverCliNotification(
        {
          title: 'Build Done',
          message: 'All checks passed',
          status: 'completed',
          sessionId: 'sess_abc12345',
          workDir: dir,
        },
        { config, store, adapters },
      );
      expect(delivered).toEqual({ success: true, botName: 'agy_tg' });
      expect(send).toHaveBeenLastCalledWith(
        'chat_1',
        {
          card: expect.objectContaining({
            type: 'final',
            title: 'Build Done',
            content: 'All checks passed',
            buttons: [{ text: '📱 在此接管对话', value: 'resume:sess_abc12345', type: 'primary' }],
          }),
        },
        { threadId: 'topic_7' },
      );

      const access = await store.getSessionAccess('agy', 'sess_abc12345');
      expect(access).toEqual([
        expect.objectContaining({ key, agentName: 'agy', workingDirectory: dir }),
      ]);

      await handleBridgeCommand(
        { command: 'watch', args: ['off'] },
        key,
        'agy_tg',
        'chat_1',
        adapter,
        store,
        {} as never,
        {} as never,
        undefined,
        undefined,
        new Map(),
        { fastModeBySession: new Map() },
        botConfig,
        { platform: 'telegram', chatType: 'private', userId: 'user_1' },
      );
      expect(await store.getWatchTarget('agy_tg')).toBeNull();
    } finally {
      store.close();
    }
  });

  it('filters group relay targets when specific bots are @mentioned and broadcasts otherwise', () => {
    const candidates = ['codexbot', 'agy', 'agy-tg', 'ccbot'];
    expect(selectDirectedRelayTargets('大家帮我看看这个改动', candidates)).toEqual(candidates);
    expect(selectDirectedRelayTargets('请 @agy-tg 检查一下', candidates)).toEqual(['agy-tg']);
    expect(selectDirectedRelayTargets('@codexbot 和 @CCBOT，一起看一下', candidates)).toEqual([
      'codexbot',
      'ccbot',
    ]);
    expect(selectDirectedRelayTargets('发邮件给 dev@codexbot.com 不应定向', candidates)).toEqual(candidates);
  });

  it('dispatches /diff-review via controls.runPrompt and blocks when running', async () => {
    const dir = makeTempDir();
    const store = await SessionStore.create(':memory:');
    try {
      const send = vi.fn().mockResolvedValue('msg');
      const runPrompt = vi.fn().mockResolvedValue(undefined);
      const adapter = { name: 'feishu', send } as unknown as PlatformAdapter;
      const botConfig = {
        agent: 'claude-code',
        platform: 'feishu' as const,
        workingDirectory: dir,
        allowFrom: ['u1'],
        permissionMode: 'blacklist' as const,
      };
      const scope = 'feishu:chat1:ccbot' as SessionKey;

      await store.updatePreferences(scope, { taskState: 'running' });
      await handleBridgeCommand(
        { command: 'diff-review', args: ['auth'] },
        scope,
        'ccbot',
        'chat1',
        adapter,
        store,
        {} as never,
        {} as never,
        undefined,
        undefined,
        new Map(),
        { fastModeBySession: new Map() },
        botConfig,
        { platform: 'feishu', chatType: 'p2p', userId: 'u1' },
        undefined,
        { runPrompt },
      );
      expect(runPrompt).not.toHaveBeenCalled();

      await store.updatePreferences(scope, { taskState: 'completed' });
      await handleBridgeCommand(
        { command: 'diff-review', args: ['auth', 'security'] },
        scope,
        'ccbot',
        'chat1',
        adapter,
        store,
        {} as never,
        {} as never,
        undefined,
        undefined,
        new Map(),
        { fastModeBySession: new Map() },
        botConfig,
        { platform: 'feishu', chatType: 'p2p', userId: 'u1' },
        undefined,
        { runPrompt },
      );
      expect(runPrompt).toHaveBeenCalledWith(expect.stringContaining('git diff'));
      expect(runPrompt).toHaveBeenCalledWith(expect.stringContaining('重点关注：auth security'));
    } finally {
      store.close();
    }
  });

  it('runs online doctor probes while scrubbing tokens and serves escaping-safe /dashboard', async () => {
    const secretTg = '123456:ABCdefSecretToken';
    const secretFeishu = 'feishu-super-secret';
    const mockFetch = vi.fn(async (url: string | URL) => {
      const target = String(url);
      if (target.includes('open.feishu.cn')) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: 't-xyz' }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: false, description: `Unauthorized for ${secretTg}` }), {
        status: 401,
      });
    }) as unknown as typeof fetch;

    const results = await runOnlineDoctorProbes(
      {
        bots: {
          ccbot: {
            agent: 'claude-code',
            platform: 'feishu',
            feishu: { appId: 'cli_id', appSecret: secretFeishu },
            workingDirectory: '/tmp',
            allowFrom: ['u1'],
            permissionMode: 'blacklist',
          },
          'codexbot-tg': {
            agent: 'codex',
            platform: 'telegram',
            telegram: { token: secretTg },
            workingDirectory: '/tmp',
            allowFrom: ['u1'],
            permissionMode: 'blacklist',
          },
        },
        agents: {},
      } as unknown as AppConfig,
      mockFetch,
    );

    expect(results[0]).toMatchObject({ botName: 'ccbot', platform: 'feishu', ok: true });
    expect(results[1]).toMatchObject({ botName: 'codexbot-tg', platform: 'telegram', ok: false });
    const formatted = formatOnlineDoctorSection(results);
    expect(formatted).not.toContain(secretTg);
    expect(formatted).not.toContain(secretFeishu);
    expect(formatted).toContain('[REDACTED]');

    const html = renderDashboardHtml({
      generatedAt: Date.now(),
      uptimeMs: 65_000,
      activeTasks: 2,
      rssMb: 90,
      contentGuardStatus: 'active',
      contentGuardBackend: 'builtin',
      networkSummary: 'environment; dns_ok',
      watchTargets: 1,
      bots: [
        {
          name: '<script>xss</script>',
          platform: 'feishu',
          agent: 'agy',
          model: 'gemini-3.8-flash-high',
          effort: 'medium',
          state: 'running',
          acceptsMessages: true,
        },
      ],
    });
    expect(html).not.toContain('<script>xss</script>');
    expect(html).toContain('&lt;script&gt;xss&lt;/script&gt;');

    const server = new HttpServer('dash-secret', {
      acceptHandoff: vi.fn().mockResolvedValue({ success: true }),
      releaseHandoff: vi.fn().mockResolvedValue({ sessionId: 's1', resumeCommand: 'cmd' }),
      getStatus: () => ({ uptime: 1000, activeSessions: 0, bots: [] }),
      getDashboardHtml: () => html,
      notify: vi.fn().mockResolvedValue({ success: true, botName: 'agy_bot' }),
      doctor: vi.fn(async (opts) => (opts?.online ? 'online-ok' : 'offline-ok')),
    });
    await server.start('127.0.0.1', 0);
    try {
      const addr = (server as unknown as { server: { address: () => { port: number } } }).server.address();
      expect((await fetch(`http://127.0.0.1:${addr.port}/dashboard`)).status).toBe(401);

      const okDash = await fetch(`http://127.0.0.1:${addr.port}/dashboard?token=dash-secret`);
      expect(okDash.status).toBe(200);
      expect(okDash.headers.get('cache-control')).toBe('no-store');
      expect(okDash.headers.get('referrer-policy')).toBe('no-referrer');
      expect(await okDash.text()).toContain('CLI2IM Bridge Status');

      const docOnline = await fetch(`http://127.0.0.1:${addr.port}/api/doctor?online=1`, {
        headers: { authorization: 'Bearer dash-secret' },
      });
      expect(await docOnline.json()).toBe('online-ok');

      const notifyResp = await fetch(`http://127.0.0.1:${addr.port}/api/notify`, {
        method: 'POST',
        headers: { authorization: 'Bearer dash-secret', 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'done' }),
      });
      expect(notifyResp.status).toBe(200);
    } finally {
      await server.stop();
    }
  });

  it('formatTopReport tolerates missing platform/optional fields and formats enriched statuses', () => {
    const output = formatTopReport(
      { uptime: 12_300, activeSessions: 2 },
      [
        { name: 'agy_bot', state: 'running', acceptsMessages: true },
        { name: 'codex-tg', platform: 'telegram', state: 'failed', acceptsMessages: false, error: 'start_failed' },
      ],
    );
    expect(output).toContain('CLI2IM Top | Uptime: 12s | Bots: 1/2 running | Active tasks: 2');
    expect(output).toContain('agy_bot         -          running    true       -');
    expect(output).toContain('codex-tg        telegram   failed     false      start_failed');
  });
});
