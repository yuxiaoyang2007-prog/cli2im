import type { SpawnOpts } from '../types.js';
import { buildChildEnv, type ChildProvider } from '../security/child-env.js';
import { assertNoProviderCredentials } from './admission.js';
import { tomlInline, isolationEnvironment } from './codex.js';
import { assertIsolationSearchPath } from './policy.js';

/** Only check.ts creates this process-local marker; configuration never grants an exemption. */
const checks = new WeakMap<SpawnOpts, { url: string; env: Record<string, string>; placeholder: string }>();
export function createCheckOptions(agent: string, production: SpawnOpts, env: Record<string, string>, url: string, placeholder = 'cli2im-check-placeholder') {
  if (!production.isolation) throw new Error('Isolation check requires a production policy');
  assertIsolationSearchPath(env, production.isolation);
  assertNoProviderCredentials(env);
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port || endpoint.username || endpoint.password) {
    throw new Error('Isolation model must be loopback only');
  }
  const noProxy = (value = '') => [...new Set([...value.split(',').filter(Boolean), '127.0.0.1', 'localhost'])].join(',');
  const access: Record<string, string> = agent === 'claude-code'
    ? { ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: placeholder }
    : {};
  const checkEnv = { ...isolationEnvironment(env, production.isolation), ...access, NO_PROXY: noProxy(env.NO_PROXY), no_proxy: noProxy(env.no_proxy) } as Record<string, string>;
  const opts: SpawnOpts = { ...production, model: production.model ?? (agent === 'claude-code' ? 'claude-sonnet-4-6' : 'gpt-5.4') };
  checks.set(opts, { url, env: checkEnv, placeholder });
  return { opts, checkOverrides: {
    modelAccess: { url, credential: 'placeholder', credentialTransport: agent === 'codex' ? 'experimental_bearer_token' : 'ANTHROPIC_API_KEY', NO_PROXY: checkEnv.NO_PROXY, no_proxy: checkEnv.no_proxy },
    persistence: agent === 'claude-code' ? { persistSession: false } : { ephemeral: true },
    modelMetadata: { model: opts.model, ...(agent === 'codex' ? { provider: 'cli2im-isolation-check', wireApi: 'responses' } : {}) },
  } };
}
export function agentChildEnv(agent: ChildProvider, opts: SpawnOpts): Record<string, string> {
  const env = checks.get(opts)?.env ?? buildChildEnv(agent, opts.env);
  if (opts.isolation) assertIsolationSearchPath(env, opts.isolation);
  return opts.isolation ? isolationEnvironment(env, opts.isolation) : env;
}
export function claudeCheckOptions(opts: SpawnOpts): { persistSession?: false } {
  return checks.has(opts) ? { persistSession: false } : {};
}
const CHECK_PROVIDER = 'cli2im-isolation-check';
if (!/^[a-zA-Z0-9_-]+$/.test(CHECK_PROVIDER)) throw new Error('Invalid check provider key');
export function codexCheckArgs(opts: SpawnOpts): string[] {
  const check = checks.get(opts);
  return check ? ['--ephemeral', '-c', 'model_provider="cli2im-isolation-check"', '-c',
    `model_providers.${CHECK_PROVIDER}=${tomlInline({ name: 'Local isolation check', base_url: check.url + '/v1',
      wire_api: 'responses', experimental_bearer_token: check.placeholder, requires_openai_auth: false })}`] : [];
}
