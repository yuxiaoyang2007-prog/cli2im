import { execFileSync } from 'node:child_process';
import * as http from 'node:http';
import { Agent as HttpsAgent, type AgentOptions as HttpsAgentOptions } from 'node:https';
import { connect } from 'node:net';

export interface NetworkPolicyConfig {
  mode: 'system' | 'environment';
  required: boolean;
  noProxy?: string[];
}
export interface ProxySettings { httpProxy: string; httpsProxy: string; noProxy: string }
const LOCAL_EXCEPTIONS = ['127.0.0.1', 'localhost', '::1'];
let active: ProxySettings | undefined;
let ready = true;
let policy: NetworkPolicyConfig | undefined;

export function parseMacSystemProxy(output: string): ProxySettings {
  const value = (key: string) => output.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, 'm'))?.[1].trim();
  const address = (prefix: string) => {
    if (value(`${prefix}Enable`) !== '1') return '';
    const host = value(`${prefix}Proxy`);
    const port = Number(value(`${prefix}Port`));
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('系统代理地址无效');
    return normalizeProxy(`http://${host.includes(':') ? `[${host}]` : host}:${port}`);
  };
  return { httpProxy: address('HTTP'), httpsProxy: address('HTTPS'), noProxy: LOCAL_EXCEPTIONS.join(',') };
}

function normalizeProxy(raw: string): string {
  if (!raw) return '';
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('需要 HTTP/HTTPS 代理，不能自动退回直连');
  }
  return url.href.replace(/\/$/, '');
}

export function resolveProxySettings(config: NetworkPolicyConfig, env = process.env,
  systemOutput?: string): ProxySettings {
  const settings = config.mode === 'system'
    ? parseMacSystemProxy(systemOutput ?? readSystemProxy())
    : { httpProxy: normalizeProxy(env.http_proxy ?? env.HTTP_PROXY ?? ''),
      httpsProxy: normalizeProxy(env.https_proxy ?? env.HTTPS_PROXY ?? ''), noProxy: '' };
  if (config.required && (!settings.httpProxy || !settings.httpsProxy)) {
    throw new Error('必需的系统代理未启用，联网已停止');
  }
  const exceptions = config.noProxy ?? LOCAL_EXCEPTIONS;
  if (config.required && exceptions.some((host) => !LOCAL_EXCEPTIONS.includes(host))) {
    throw new Error('强制代理模式只允许本机地址直连');
  }
  settings.noProxy = [...new Set(exceptions)].join(',');
  return settings;
}

function readSystemProxy(): string {
  if (process.platform !== 'darwin') throw new Error('当前系统请使用 environment 代理模式');
  return execFileSync('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf8', timeout: 3000 });
}

export function applyProxyEnvironment(settings: ProxySettings, env = process.env): void {
  for (const key of ['HTTP_PROXY', 'http_proxy']) env[key] = settings.httpProxy;
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']) env[key] = settings.httpsProxy;
  for (const key of ['NO_PROXY', 'no_proxy']) env[key] = settings.noProxy;
  env.NODE_USE_ENV_PROXY = '1';
}

/** WebSocket upgrades do not use Node's global proxy agent; give WSS its own route. */
export function createWebSocketProxyAgent(env = process.env): HttpsAgent | undefined {
  const proxy = normalizeProxy(env.https_proxy ?? env.HTTPS_PROXY ?? '');
  if (!proxy) {
    if (env.CLI2IM_NETWORK_REQUIRED === '1') throw new Error('飞书长连接所需代理未启用');
    return undefined;
  }
  if (typeof (http as unknown as { setGlobalProxyFromEnv?: unknown }).setGlobalProxyFromEnv !== 'function') {
    throw new Error('长连接代理保护需要 Node.js 24.14+ 或 25.4+');
  }
  // Use the current normalized HTTPS route even if a broad inherited NO_PROXY exists.
  // This instance is replaced whenever the adapter reconnects after a routing change.
  const agent = new HttpsAgent({
    proxyEnv: { HTTPS_PROXY: proxy, https_proxy: proxy, HTTP_PROXY: proxy, http_proxy: proxy, NO_PROXY: '', no_proxy: '' },
  } as HttpsAgentOptions) as HttpsAgent & {
    addRequest(request: http.ClientRequest, options: http.RequestOptions): void;
  };
  const addRequest = agent.addRequest;
  const destroy = agent.destroy;
  let retired = false;
  // Node's destroy() releases sockets but leaves the agent reusable. A delayed
  // SDK endpoint response must not open another connection through the old route.
  agent.destroy = function () {
    retired = true;
    destroy.call(this);
  };
  agent.addRequest = function (request, options) {
    if (retired) {
      // Use Node Agent's socket-failure path: destroy() alone cannot settle a
      // request that was never assigned a socket. Defer until ws has listeners.
      const error = Object.assign(new Error('WebSocket proxy agent is retired'), { code: 'ERR_PROXY_AGENT_RETIRED' });
      queueMicrotask(() => {
        Reflect.apply(request.onSocket, request, [undefined, error]);
      });
      return;
    }
    addRequest.call(this, request, options);
  };
  return agent;
}

export async function proxyReachable(proxy: string): Promise<boolean> {
  if (!proxy) return false;
  const url = new URL(proxy);
  return new Promise((resolve) => {
    const socket = connect({ host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)) });
    let done = false;
    const finish = (ok: boolean) => { if (done) return; done = true; socket.destroy(); resolve(ok); };
    socket.setTimeout(1500, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

export async function configureNetworkPolicy(config?: NetworkPolicyConfig): Promise<void> {
  policy = config;
  if (!config) return;
  await refreshNetworkPolicy();
}

/** Refresh only between bot runs/connections; callers quiesce on a change. */
export async function refreshNetworkPolicy(beforeChange?: () => Promise<void>): Promise<{ changed: boolean; ready: boolean }> {
  if (!policy) return { changed: false, ready: true };
  try {
    const settings = resolveProxySettings(policy);
    const changed = JSON.stringify(settings) !== JSON.stringify(active);
    if (changed) {
      await beforeChange?.();
      const reset = (http as unknown as { setGlobalProxyFromEnv?: (env: NodeJS.ProcessEnv) => unknown }).setGlobalProxyFromEnv;
      if (!reset) throw new Error('代理保护需要 Node.js 24.14+ 或 25.4+');
      applyProxyEnvironment(settings);
      process.env.CLI2IM_NETWORK_REQUIRED = policy.required ? '1' : '0';
      reset(process.env);
      active = settings;
    }
    ready = !policy.required || (await proxyReachable(settings.httpProxy) && await proxyReachable(settings.httpsProxy));
    return { changed, ready };
  } catch {
    ready = false;
    // Retain existing proxy environment. Never erase it on system-proxy failure.
    return { changed: false, ready: false };
  }
}

export function assertNetworkReady(): void {
  if (!ready) throw new Error('代理未就绪，任务尚未开始；请恢复代理后重试');
}

export function networkPolicyStatus(): { mode: string; required: boolean; ready: boolean; dns: string } {
  return { mode: policy?.mode ?? 'unmanaged', required: policy?.required ?? false, ready,
    dns: '系统 DNS 和忽略代理的子程序需另行验证；端口连通不是防泄露证明' };
}
