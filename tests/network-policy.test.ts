import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  scutil: vi.fn(), connect: vi.fn(), reset: vi.fn(), reachable: true,
}));
vi.mock('node:child_process', () => ({ execFileSync: mocks.scutil }));
vi.mock('node:net', () => ({ connect: mocks.connect }));
vi.mock('node:http', () => ({ setGlobalProxyFromEnv: mocks.reset }));

const PROXY_KEYS = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy', 'NODE_USE_ENV_PROXY', 'CLI2IM_NETWORK_REQUIRED'];
const systemProxy = (port = 7890) => `<dictionary> {
  HTTPEnable : 1
  HTTPProxy : 127.0.0.1
  HTTPPort : ${port}
  HTTPSEnable : 1
  HTTPSProxy : 127.0.0.1
  HTTPSPort : ${port}
}`;

describe('network policy', () => {
  beforeEach(() => {
    vi.resetModules();
    for (const key of PROXY_KEYS) vi.stubEnv(key, process.env[key]);
    vi.stubEnv('http_proxy', 'http://127.0.0.1:7890');
    vi.stubEnv('https_proxy', 'http://127.0.0.1:7890');
    mocks.scutil.mockReset().mockReturnValue(systemProxy());
    mocks.reset.mockReset();
    mocks.reachable = true;
    mocks.connect.mockReset().mockImplementation(() => {
      const socket = Object.assign(new EventEmitter(), { setTimeout: vi.fn(), destroy: vi.fn() });
      queueMicrotask(() => socket.emit(mocks.reachable ? 'connect' : 'error', new Error('connection refused')));
      return socket;
    });
  });
  afterEach(() => vi.unstubAllEnvs());

  it('reads active macOS HTTP and HTTPS endpoints, including IPv6 loopback', async () => {
    const { parseMacSystemProxy } = await import('../src/security/network-policy.js');
    expect(parseMacSystemProxy(systemProxy())).toEqual({ httpProxy: 'http://127.0.0.1:7890', httpsProxy: 'http://127.0.0.1:7890', noProxy: '127.0.0.1,localhost,::1' });
    expect(parseMacSystemProxy(systemProxy().replaceAll('127.0.0.1', '::1')).httpProxy).toBe('http://[::1]:7890');
    for (const port of [0, 65536, 1.5]) expect(() => parseMacSystemProxy(systemProxy(port))).toThrow();
  });

  it('refuses required mode when either proxy is disabled or absent', async () => {
    const { resolveProxySettings } = await import('../src/security/network-policy.js');
    const policy = { mode: 'system' as const, required: true };
    expect(() => resolveProxySettings(policy, {}, systemProxy().replace('HTTPEnable : 1', 'HTTPEnable : 0'))).toThrow('联网已停止');
    expect(() => resolveProxySettings(policy, {}, '<dictionary> {}')).toThrow('联网已停止');
    expect(() => resolveProxySettings({ mode: 'environment', required: true }, { HTTP_PROXY: 'http://localhost:7890' })).toThrow();
  });

  it('normalizes both cases and removes inherited public-domain bypasses', async () => {
    const { resolveProxySettings, applyProxyEnvironment } = await import('../src/security/network-policy.js');
    const env: NodeJS.ProcessEnv = { HTTP_PROXY: 'http://localhost:1111', http_proxy: 'http://localhost:2222', HTTPS_PROXY: 'http://localhost:3333', NO_PROXY: '*', no_proxy: '.feishu.cn' };
    const settings = resolveProxySettings({ mode: 'environment', required: true }, env);
    applyProxyEnvironment(settings, env);
    expect(env.HTTP_PROXY).toBe('http://localhost:2222');
    expect(env.http_proxy).toBe(env.HTTP_PROXY);
    expect(env.https_proxy).toBe(env.HTTPS_PROXY);
    expect(env.all_proxy).toBe(env.HTTPS_PROXY);
    expect(env.ALL_PROXY).toBe(env.HTTPS_PROXY);
    expect(env.NO_PROXY).toBe('127.0.0.1,localhost,::1');
    expect(env.no_proxy).toBe(env.NO_PROXY);
    expect(env.NODE_USE_ENV_PROXY).toBe('1');
  });

  it('allows only exact loopback exceptions in required mode', async () => {
    const { resolveProxySettings } = await import('../src/security/network-policy.js');
    for (const exception of ['*', '.feishu.cn', 'api.example.com', '127.0.0.1.evil.invalid', '127.0.0.0/8']) {
      expect(() => resolveProxySettings({ mode: 'system', required: true, noProxy: [exception] }, {}, systemProxy())).toThrow('本机地址直连');
    }
    expect(resolveProxySettings({ mode: 'system', required: true, noProxy: ['localhost', 'localhost'] }, {}, systemProxy()).noProxy).toBe('localhost');
  });

  it('rejects unsupported proxy schemes and does not silently substitute direct access', async () => {
    const { resolveProxySettings } = await import('../src/security/network-policy.js');
    for (const proxy of ['socks5://localhost:7890', 'http://localhost:7890/private-path', 'http://localhost:7890/?token=private']) {
      expect(() => resolveProxySettings({ mode: 'environment', required: true }, { HTTP_PROXY: proxy, HTTPS_PROXY: proxy })).toThrow();
    }
  });

  it('creates a fresh explicit WebSocket route from the current HTTPS proxy without bypasses', async () => {
    const { createWebSocketProxyAgent } = await import('../src/security/network-policy.js');
    const env = { HTTPS_PROXY: 'http://localhost:1111', https_proxy: 'http://localhost:2222', NO_PROXY: '*', no_proxy: '*' };
    const first = createWebSocketProxyAgent(env)!;
    env.https_proxy = 'http://localhost:3333';
    const second = createWebSocketProxyAgent(env)!;
    expect(first).not.toBe(second);
    expect(first.options).toMatchObject({ proxyEnv: { HTTPS_PROXY: 'http://localhost:2222', https_proxy: 'http://localhost:2222', NO_PROXY: '', no_proxy: '' } });
    expect(second.options).toMatchObject({ proxyEnv: { HTTPS_PROXY: 'http://localhost:3333', https_proxy: 'http://localhost:3333', NO_PROXY: '', no_proxy: '' } });
    first.destroy();
    second.destroy();
  });

  it('refuses a missing or invalid required WebSocket proxy before connecting', async () => {
    const { createWebSocketProxyAgent } = await import('../src/security/network-policy.js');
    expect(() => createWebSocketProxyAgent({ CLI2IM_NETWORK_REQUIRED: '1' })).toThrow('代理未启用');
    expect(() => createWebSocketProxyAgent({ CLI2IM_NETWORK_REQUIRED: '1', https_proxy: 'socks5://localhost:7890' })).toThrow('不能自动退回直连');
    expect(createWebSocketProxyAgent({})).toBeUndefined();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('permanently retires a destroyed WebSocket agent and rejects late requests asynchronously', async () => {
    const { createWebSocketProxyAgent } = await import('../src/security/network-policy.js');
    const agent = createWebSocketProxyAgent({ https_proxy: 'http://localhost:7890' })!;
    const lateRequest = { onSocket: vi.fn() };
    agent.destroy();
    (agent as unknown as { addRequest(request: unknown, options: unknown): void }).addRequest(lateRequest, {});
    expect(lateRequest.onSocket).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(lateRequest.onSocket).toHaveBeenCalledOnce();
    expect(lateRequest.onSocket).toHaveBeenCalledWith(undefined, expect.objectContaining({ code: 'ERR_PROXY_AGENT_RETIRED' }));
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('blocks new work when the proxy port is unreachable while retaining proxy environment', async () => {
    const policy = await import('../src/security/network-policy.js');
    mocks.reachable = false;
    await policy.configureNetworkPolicy({ mode: 'environment', required: true });
    expect(policy.networkPolicyStatus()).toMatchObject({ ready: false, required: true });
    expect(() => policy.assertNetworkReady()).toThrow('任务尚未开始');
    expect(process.env.HTTP_PROXY).toBe('http://127.0.0.1:7890');
    expect(process.env.NO_PROXY).toBe('127.0.0.1,localhost,::1');
    expect(process.env.CLI2IM_NETWORK_REQUIRED).toBe('1');
    expect(mocks.reset).toHaveBeenCalledOnce();
  });

  it.runIf(process.platform === 'darwin')('keeps existing proxy routes when the system disables them or settings cannot be read', async () => {
    const policy = await import('../src/security/network-policy.js');
    await policy.configureNetworkPolicy({ mode: 'system', required: true });
    expect(() => policy.assertNetworkReady()).not.toThrow();
    mocks.scutil.mockReturnValue('<dictionary> {}');
    expect(await policy.refreshNetworkPolicy()).toEqual({ changed: false, ready: false });
    expect(process.env.HTTPS_PROXY).toBe('http://127.0.0.1:7890');
    expect(() => policy.assertNetworkReady()).toThrow();
    mocks.scutil.mockImplementation(() => { throw new Error('system read failed'); });
    expect((await policy.refreshNetworkPolicy()).ready).toBe(false);
    expect(process.env.NO_PROXY).not.toBe('*');
    expect(mocks.reset).toHaveBeenCalledOnce();
  });

  it('quiesces before changing global routing and resumes readiness only after checking the new proxy', async () => {
    const policy = await import('../src/security/network-policy.js');
    await policy.configureNetworkPolicy({ mode: 'environment', required: true });
    const events: string[] = [];
    mocks.reset.mockImplementation(() => events.push('change-route'));
    process.env.http_proxy = 'http://127.0.0.1:9000';
    process.env.https_proxy = 'http://127.0.0.1:9000';
    const outcome = await policy.refreshNetworkPolicy(async () => { events.push('stop-bots'); });
    expect(events).toEqual(['stop-bots', 'change-route']);
    expect(outcome).toEqual({ changed: true, ready: true });
    expect(process.env.HTTPS_PROXY).toBe('http://127.0.0.1:9000');
    expect(policy.networkPolicyStatus().dns).toContain('端口连通不是防泄露证明');
  });
});
