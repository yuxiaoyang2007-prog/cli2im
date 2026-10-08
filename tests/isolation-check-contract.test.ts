import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { isolationFixture } from './helpers/isolation.js';
import { createCheckOptions, agentChildEnv, claudeCheckOptions, codexCheckArgs } from '../src/isolation/check-options.js';
import { isolationEnvironment } from '../src/isolation/codex.js';
import { buildIsolationPolicy } from '../src/isolation/policy.js';
import { codexExecArgs } from '../src/agents/codex-exec.js';
import { ClaudeCodePlugin } from '../src/agents/claude-code.js';
import { assertNoProviderCredentials } from '../src/isolation/admission.js';
import { buildChildEnv } from '../src/security/child-env.js';
import type { SpawnOpts } from '../src/types.js';

vi.mock('../src/security/child-env.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/security/child-env.js')>();
  return { ...actual, buildChildEnv: (provider: any, env: any, inherited = { PATH: '/usr/bin:/bin' }) => actual.buildChildEnv(provider, env, inherited) };
});

describe('slice 9 production/check parameter contract', () => {
  let f: ReturnType<typeof isolationFixture>;
  beforeEach(() => { f = isolationFixture(); });
  afterEach(() => { vi.restoreAllMocks(); rmSync(f.root, { recursive: true, force: true }); });
  const production = (): SpawnOpts => ({ workingDirectory: f.workspace, isolation: f.policy(),
    permissionMode: 'blacklist', model: 'fixture-model', reasoningEffort: 'high', autoApprove: false,
    env: isolationEnvironment({ HOME: f.paths.home, PATH: '/usr/bin:/bin', TMPDIR: f.policy().tmpdir, NO_PROXY: 'example.invalid', no_proxy: 'internal.invalid' }, f.policy()) });

  it.each(['claude-code', 'codex'] as const)('disables global Git config only for isolated %s production and checks', agent => {
    f.bot.agent = agent;
    expect(isolationEnvironment({}).GIT_CONFIG_GLOBAL).toBe('/dev/null');
    expect(isolationEnvironment({ GIT_CONFIG_GLOBAL: '/fixture/inherited.gitconfig' }).GIT_CONFIG_GLOBAL).toBe('/dev/null');
    const original = production();
    delete original.env!.GIT_CONFIG_GLOBAL;
    expect(agentChildEnv(agent, { ...original, isolation: undefined })).not.toHaveProperty('GIT_CONFIG_GLOBAL');
    original.env!.GIT_CONFIG_GLOBAL = '/fixture/inherited.gitconfig';
    expect(agentChildEnv(agent, { ...original, isolation: undefined }).GIT_CONFIG_GLOBAL).toBe('/fixture/inherited.gitconfig');
    const env = agentChildEnv(agent, original);
    expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
    const check = createCheckOptions(agent, original, original.env!, 'http://127.0.0.1:12345');
    expect(agentChildEnv(agent, check.opts).GIT_CONFIG_GLOBAL).toBe('/dev/null');
    const policy = (envKeys: string[]) => buildIsolationPolicy({ config: f.config, botName: 'bot', workspace: f.workspace,
      paths: f.paths, binaryPath: '/bin/cat', effectiveEnv: env, production: { permissionMode: original.permissionMode, envKeys } });
    const keys = Object.keys(env);
    expect(policy(keys).fingerprint).not.toBe(policy(keys.filter(key => key !== 'GIT_CONFIG_GLOBAL')).fingerprint);
  });
  it.each(['claude-code', 'codex'])('only local model access changes environment for %s; checkOverrides stays outside policy', agent => {
    if (agent === 'claude-code') f.bot.agent = agent;
    const original = production();
    const originalJSON = JSON.stringify(original);
    const first = createCheckOptions(agent, original, original.env!, 'http://127.0.0.1:12345');
    const second = createCheckOptions(agent, original, original.env!, 'http://127.0.0.1:23456');
    expect(JSON.stringify(original)).toBe(originalJSON);
    expect(first.opts).toEqual(original);
    expect(first.opts.isolation).toBe(original.isolation);
    expect(second.opts.isolation!.fingerprint).toBe(original.isolation!.fingerprint);
    expect(first.checkOverrides).not.toEqual(second.checkOverrides);
    const env = agentChildEnv(agent as 'codex' | 'claude-code', first.opts);
    const allowed = ['NO_PROXY', 'no_proxy', ...(agent === 'claude-code' ? ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY'] : [])];
    for (const key of new Set([...Object.keys(original.env!), ...Object.keys(env)])) {
      if (!allowed.includes(key)) expect(env[key]).toBe(original.env![key]);
    }
    expect(env.NO_PROXY).toBe('example.invalid,127.0.0.1,localhost');
    expect(env.no_proxy).toBe('internal.invalid,127.0.0.1,localhost');
    expect(first.checkOverrides.modelAccess).toMatchObject({ NO_PROXY: env.NO_PROXY, no_proxy: env.no_proxy, credential: 'placeholder' });
  });
  it.each(['claude-code', 'codex'] as const)('rejects unsafe or changed effective PATH in production and checks for %s, preserving non-isolated PATH', agent => {
    f.bot.agent = agent;
    const original = production();
    for (const PATH of ['bin:/usr/bin', '', ':/usr/bin', '/usr/bin:', '.', `${f.workspace}/bin:/usr/bin`, '/bin:/usr/bin']) {
      const env = { ...original.env, PATH };
      expect(() => agentChildEnv(agent, { ...original, env })).toThrow(/^UNSUPPORTED:.*PATH/);
      expect(() => createCheckOptions(agent, original, env, 'http://127.0.0.1:12345')).toThrow(/^UNSUPPORTED:.*PATH/);
      expect(agentChildEnv(agent, { ...original, isolation: undefined, env }).PATH).toBe(PATH);
    }
  });
  it('check-only placeholder authority is bound to an unforgeable options identity', () => {
    const original = production();
    const { opts } = createCheckOptions('codex', original, original.env!, 'http://127.0.0.1:12345');
    expect(agentChildEnv('codex', opts).OPENAI_API_KEY).toBeUndefined();
    expect(codexCheckArgs(opts).join(' ')).toContain('experimental_bearer_token');
    expect(agentChildEnv('codex', { ...opts }).OPENAI_API_KEY).toBeUndefined();
    expect(codexCheckArgs({ ...opts })).toEqual([]);
    expect(claudeCheckOptions({ ...opts })).toEqual({});
    expect(() => assertNoProviderCredentials(agentChildEnv('codex', opts))).not.toThrow();
    expect(() => createCheckOptions('codex', original, { ...original.env, OPENAI_API_KEY: 'fixture-key' }, 'http://127.0.0.1:12345')).toThrow();
  });
  it('loopback bypass remains effective under the production network-override guard', () => {
    const original = production();
    const inherited = { CLI2IM_NETWORK_REQUIRED: '1', HTTPS_PROXY: 'http://127.0.0.1:1', NO_PROXY: 'internal.invalid', no_proxy: 'another.invalid' };
    const productionEnv = buildChildEnv('codex', { ...original.env, NO_PROXY: 'ignored.invalid' }, inherited);
    expect(productionEnv.NO_PROXY).toBe('internal.invalid');
    const { opts, checkOverrides } = createCheckOptions('codex', original, productionEnv, 'http://127.0.0.1:12345');
    const env = agentChildEnv('codex', opts);
    expect(env.HTTPS_PROXY).toBe(inherited.HTTPS_PROXY);
    expect(env.CLI2IM_NETWORK_REQUIRED).toBe('1');
    expect(env.NO_PROXY).toBe('internal.invalid,127.0.0.1,localhost');
    expect(env.no_proxy).toBe('another.invalid,127.0.0.1,localhost');
    expect(checkOverrides.modelAccess).toMatchObject({ NO_PROXY: env.NO_PROXY, no_proxy: env.no_proxy });
  });
  it.each(['https://127.0.0.1:1234', 'http://localhost:1234', 'http://0.0.0.0:1234', 'http://127.0.0.1', 'http://user:pass@127.0.0.1:1234'])('rejects non-contract model endpoint %s', url => {
    const original = production();
    expect(() => createCheckOptions('codex', original, original.env!, url)).toThrow();
  });
  it('Codex exec argv differs only in provider and ephemeral parameters; production resume stays intact', () => {
    const original = production();
    const { opts } = createCheckOptions('codex', original, original.env!, 'http://127.0.0.1:12345');
    const actual = codexExecArgs(opts);
    const overrides = codexCheckArgs(opts);
    const index = actual.indexOf('--ephemeral');
    expect(index).toBeGreaterThan(0);
    expect(actual.slice(index, index + overrides.length)).toEqual(overrides);
    expect([...actual.slice(0, index), ...actual.slice(index + overrides.length)]).toEqual(codexExecArgs(original));
    expect(overrides).toHaveLength(5);
    expect(overrides[2]).toBe('model_provider="cli2im-isolation-check"');
    expect(overrides[4]).toMatch(/^model_providers\.cli2im-isolation-check=\{/);
    expect(overrides[4]).not.toContain('env_key');
    expect(overrides[4]).toContain('"experimental_bearer_token"="cli2im-check-placeholder"');
    expect(overrides[4]).toContain('"requires_openai_auth"=false');
    expect(overrides[4]).toContain('"base_url"="http://127.0.0.1:12345/v1"');
    expect(codexExecArgs(original, 'existing-id').slice(-4)).toEqual(['resume', '--', 'existing-id', '-']);
    expect(codexExecArgs(original)).not.toContain('--ephemeral');
    expect(actual).not.toContain('--sandbox');
  });
  it('integration: production and check Claude SDK options differ only by environment and persistSession', async () => {
    f.bot.agent = 'claude-code';
    const original = production();
    original.env!.CLAUDE_CODE_TMPDIR = original.isolation!.tmpdir;
    original.appendSystemPrompt = 'fixture maintained instructions';
    const { opts } = createCheckOptions('claude-code', original, original.env!, 'http://127.0.0.1:12345');
    const query = vi.fn(() => (async function* () {})());
    const plugin = new ClaudeCodePlugin('/fixture/claude', query as any);
    const live = plugin.spawn(original); const check = plugin.spawn(opts);
    try {
      live.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'fixture' }));
      check.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'fixture' }));
      await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(2));
      const [before, after] = query.mock.calls.map(call => (call as any)[0].options);
      const normalize = (value: any, key = ''): any => {
        if (key === 'abortController') return '<AbortController>';
        if (typeof value === 'function') return '<function>';
        if (Array.isArray(value)) return value.map(item => normalize(item));
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v, k)]));
        return value;
      };
      const { env: beforeEnv, persistSession: beforePersistence, ...beforeRest } = before;
      const { env: afterEnv, persistSession: afterPersistence, ...afterRest } = after;
      expect(normalize(afterRest)).toEqual(normalize(beforeRest));
      expect(beforePersistence).toBeUndefined(); expect(afterPersistence).toBe(false);
      expect(beforeEnv.ANTHROPIC_API_KEY).toBeUndefined();
      expect(afterEnv.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:12345');
      expect(after.tools).toEqual(original.isolation!.tools);
      expect(after.settings).toEqual(before.settings);
    } finally { live.kill(); check.kill(); }
  });
});
