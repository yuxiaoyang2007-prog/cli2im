import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { isolationFixture } from './helpers/isolation.js';
import { IsolationRuntime } from '../src/isolation/runtime.js';
import { VerificationStore, identifyBinary, type VerificationRecord, type VerificationStatus } from '../src/isolation/verification.js';
import { MemoryStore } from '../src/memory/store.js';
import { SessionStore } from '../src/session/store.js';
import type { IsolationCheckInput } from '../src/isolation/check.js';
import type { SpawnOpts } from '../src/types.js';
import { runIsolationDoctor } from '../src/services/isolation-doctor.js';
import { agentChildEnv, createCheckOptions } from '../src/isolation/check-options.js';

describe('slice 9 automatic check runtime integration', () => {
  let f: ReturnType<typeof isolationFixture>;
  let verification: VerificationStore;
  let store: SessionStore;
  let binary: string;
  beforeEach(async () => {
    f = isolationFixture();
    const bin = join(f.root, 'trusted-bin'); mkdirSync(bin);
    binary = join(bin, 'fake-codex'); copyFileSync('/bin/cat', binary); chmodSync(binary, 0o700);
    f.config.agents.codex.binary = binary;
    verification = new VerificationStore(join(f.paths.dataDir, 'isolation/verification.json'));
    store = await SessionStore.create(':memory:');
  });
  afterEach(() => { store.close(); vi.restoreAllMocks(); rmSync(f.root, { recursive: true, force: true }); });
  const key = 'feishu:alice:bot' as const;
  const otherKey = 'feishu:bob:bot' as const;
  const opts = (workspace = f.workspace): SpawnOpts => ({ workingDirectory: workspace, permissionMode: 'blacklist',
    env: { HOME: f.paths.home, CODEX_HOME: join(f.root, 'codex-state') } });
  const result = (input: IsolationCheckInput, status: VerificationStatus = 'VERIFIED'): VerificationRecord => ({
    bot: input.bot, scopeKey: input.policy.scopeKey, policyFingerprint: input.policy.fingerprint, agentBinary: input.binary,
    status, checkedAt: new Date().toISOString(), checks: [{ name: 'injected-test-check', status: status === 'VERIFIED' ? 'PASS' : 'ERROR' }],
  });
  function setup(runCheck = vi.fn(async (input: IsolationCheckInput) => result(input))) {
    const invalidate = vi.fn();
    const runtime = new IsolationRuntime({ config: f.config, paths: f.paths, verification, store,
      memory: new MemoryStore(f.paths.memoryDir), inheritedEnv: { PATH: '/usr/bin:/bin', HOME: f.paths.home },
      sdkVersions: { fixture: '1' }, invalidate, runCheck, prepareTmp: async () => {} });
    return { runtime, invalidate, runCheck };
  }
  it.each(['claude-code', 'codex'] as const)('rejects unsafe effective PATH in preparation, admission and forced checks for %s', async agent => {
    f.bot.agent = agent; f.config.agents[agent] = { binary };
    const { runtime, runCheck, invalidate } = setup();
    for (const PATH of ['', 'bin:/usr/bin', '.', ':/usr/bin', '/usr/bin:', '/usr/bin::/bin', `${f.workspace}/bin:/usr/bin`]) {
      const options = opts(); options.env!.PATH = PATH;
      await expect(runtime.prepare(key, 'person:alice', f.workspace, options, {})).rejects.toMatchObject({ status: 'UNSUPPORTED' });
      expect(verification.preparationFailure('bot')?.status).toBe('UNSUPPORTED');
    }
    expect(runCheck).not.toHaveBeenCalled();
    runtime.clearPreparationFailure('bot');
    const options = opts();
    options.isolation = await runtime.prepare(key, 'person:alice', f.workspace, options, {});
    expect(runCheck).toHaveBeenCalledOnce();
    options.env!.PATH = `${f.workspace}/bin:/usr/bin`;
    await expect(runtime.assert(key)).rejects.toMatchObject({ status: 'UNSUPPORTED' });
    await expect(runtime.check(key)).rejects.toMatchObject({ status: 'UNSUPPORTED' });
    expect(runCheck).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledWith(key);
    expect(verification.get('bot', f.workspace)?.status).toBe('UNSUPPORTED');
  });
  it('uses merged overrides, rejects unsafe inherited PATH and fingerprints safe PATH changes', async () => {
    const inheritedEnv = { HOME: f.paths.home, PATH: 'bin:/usr/bin' };
    const runCheck = vi.fn(async (input: IsolationCheckInput) => result(input));
    const runtime = new IsolationRuntime({ config: f.config, paths: f.paths, verification, store,
      memory: new MemoryStore(f.paths.memoryDir), inheritedEnv, sdkVersions: {}, invalidate: vi.fn(), runCheck });
    await expect(runtime.prepare(key, 'person:alice', f.workspace, opts(), {})).rejects.toMatchObject({ status: 'UNSUPPORTED' });
    runtime.clearPreparationFailure('bot');
    const options = opts(); options.env!.PATH = '/usr/bin:/bin';
    options.isolation = await runtime.prepare(key, 'person:alice', f.workspace, options, {});
    expect(runCheck.mock.calls[0][0].env.PATH).toBe('/usr/bin:/bin');
    const before = options.isolation.fingerprint;
    options.env!.PATH = '/bin:/usr/bin';
    await expect(runtime.assert(key)).rejects.toThrow();
    const next = await runtime.prepare(key, 'person:alice', f.workspace, options, {}, false);
    expect(next.fingerprint).not.toBe(before);
    expect(verification.state('bot', f.workspace, next.fingerprint, identifyBinary(binary))).toBe('STALE');
  });
  it.each(['claude-code', 'codex'] as const)('workspace bin/node created after VERIFIED cannot replace the %s interpreter in production or checks', async agent => {
    f.bot.agent = agent; f.config.agents[agent] = { binary };
    const trustedBin = join(f.root, 'trusted-bin');
    symlinkSync(process.execPath, join(trustedBin, 'node'));
    writeFileSync(binary, '#!/usr/bin/env node\nprocess.stdout.write("trusted interpreter");\n');
    const { runtime, runCheck } = setup();
    const options = opts(); options.env!.PATH = `${trustedBin}:/usr/bin:/bin`;
    options.isolation = await runtime.prepare(key, 'person:alice', f.workspace, options, {});
    expect(verification.get('bot', f.workspace)?.status).toBe('VERIFIED');
    const shadowBin = join(f.workspace, 'bin'); mkdirSync(shadowBin);
    const marker = join(f.workspace, 'shadow-ran');
    writeFileSync(join(shadowBin, 'node'), `#!/bin/sh\nprintf unsafe > '${marker}'\n`, { mode: 0o700 });
    await runtime.assert(key);
    expect(runCheck).toHaveBeenCalledOnce();
    const check = createCheckOptions(agent, options, runCheck.mock.calls[0][0].env, 'http://127.0.0.1:12345');
    for (const launch of [options, check.opts]) {
      const env = agentChildEnv(agent, launch);
      expect(env.PATH).toBe(options.env!.PATH);
      const child = spawnSync(options.isolation.binaryPath, [], { cwd: f.workspace, env, encoding: 'utf8' });
      expect(child.status).toBe(0);
      expect(child.stdout).toBe('trusted interpreter');
    }
    expect(existsSync(marker)).toBe(false);
  });
  it('integration: startup inspection and explicit check persist a production-bound record, then admission reuses it', async () => {
    const { runtime, runCheck } = setup();
    const options = opts();
    const policy = await runtime.prepare(key, 'person:alice', f.workspace, options, {}, false);
    expect(runCheck).not.toHaveBeenCalled();
    const record = await runtime.check(key);
    expect(record).toMatchObject({ status: 'VERIFIED', policyFingerprint: policy.fingerprint, scopeKey: policy.scopeKey });
    expect(runCheck).toHaveBeenCalledOnce();
    expect(runCheck.mock.calls[0][0].env).toMatchObject({ HOME: f.paths.home, CODEX_HOME: policy.codexHome, TMPDIR: policy.tmpdir });
    expect(runCheck.mock.calls[0][0].opts).toBe(options);
    expect(policy.binaryPath).toBe(runCheck.mock.calls[0][0].binary.realpath);
    expect(runCheck.mock.calls[0][0].env).not.toHaveProperty('OPENAI_API_KEY');
    await expect(runtime.assert(key)).resolves.toBeUndefined();
    expect(runCheck).toHaveBeenCalledOnce();
    await runtime.check(key);
    expect(runCheck).toHaveBeenCalledTimes(2);
  });
  it.each(['project-config', 'unavailable-binary'])('doctor preparation failure revokes every live session and persisted VERIFIED scope: %s', async failure => {
    const { runtime, invalidate } = setup();
    await runtime.prepare(key, 'person:alice', f.workspace, opts(), {});
    const bob = f.bot.userOverrides!.bob.workingDirectory!;
    await runtime.prepare(otherKey, 'person:bob', bob, opts(bob), {});
    if (failure === 'project-config') {
      mkdirSync(join(f.workspace, '.codex')); writeFileSync(join(f.workspace, '.codex/config.toml'), 'fixture');
    } else chmodSync(binary, 0o600);
    invalidate.mockClear();
    const rows = await runIsolationDoctor({ config: f.config, paths: f.paths, runtime, identityMapping: {} });
    expect(rows.some(row => row.status === (failure === 'project-config' ? 'UNSUPPORTED' : 'ERROR'))).toBe(true);
    expect(invalidate).toHaveBeenCalledWith(key); expect(invalidate).toHaveBeenCalledWith(otherKey);
    expect(verification.get('bot', f.workspace)?.status).not.toBe('VERIFIED');
    expect(verification.preparationFailure('bot')?.checks).toEqual([{ name: 'check.preparation', status: failure === 'project-config' ? 'UNSUPPORTED' : 'ERROR' }]);
    await expect(runtime.assert(otherKey)).rejects.toThrow();
    if (failure === 'project-config') rmSync(join(f.workspace, '.codex/config.toml')); else chmodSync(binary, 0o700);
    const recovered = await runIsolationDoctor({ config: f.config, paths: f.paths, runtime, identityMapping: {} });
    expect(recovered.every(row => row.status === 'VERIFIED')).toBe(true);
    expect(verification.preparationFailure('bot')).toBeUndefined();
    await expect(runtime.assert(otherKey)).resolves.toBeUndefined();
  });
  it.each(['project-config', 'unavailable-binary'])('monitor observes independent doctor preparation failure even after another scope passes: %s', async failure => {
    const { runtime, invalidate, runCheck } = setup();
    const bob = f.bot.userOverrides!.bob.workingDirectory!;
    // Only Bob has a live process; Alice is the failed doctor scope.
    await runtime.prepare(otherKey, 'person:bob', bob, opts(bob), {});
    const external = new VerificationStore(join(f.paths.dataDir, 'isolation/verification.json'));
    const doctor = new IsolationRuntime({ config: f.config, paths: f.paths, verification: external, store,
      memory: new MemoryStore(f.paths.memoryDir), inheritedEnv: { PATH: '/usr/bin:/bin', HOME: f.paths.home },
      sdkVersions: { fixture: '1' }, invalidate: vi.fn(), runCheck });
    if (failure === 'project-config') {
      mkdirSync(join(f.workspace, '.codex')); writeFileSync(join(f.workspace, '.codex/config.toml'), 'fixture');
    } else chmodSync(binary, 0o600);
    invalidate.mockClear();
    await runIsolationDoctor({ config: f.config, paths: f.paths, runtime: doctor, identityMapping: {} });
    expect(invalidate).not.toHaveBeenCalled();
    const stop = runtime.monitor(10);
    try { await vi.waitFor(() => expect(invalidate).toHaveBeenCalledWith(otherKey)); }
    finally { stop(); }
  });
  it('first admission automatically checks an unverified scope and rejects a failed result', async () => {
    const runCheck = vi.fn(async (input: IsolationCheckInput) => result(input, 'ERROR'));
    const { runtime, invalidate } = setup(runCheck);
    await expect(runtime.prepare(key, 'person:alice', f.workspace, opts(), {})).rejects.toThrow('隔离检查未通过');
    expect(runCheck).toHaveBeenCalledOnce();
    expect(verification.get('bot', f.workspace)?.status).toBe('ERROR');
    expect(invalidate).toHaveBeenCalledWith(key);
    await expect(runtime.assert(key)).rejects.toThrow();
    expect(runCheck).toHaveBeenCalledOnce();
  });
  it('binary identity changes trigger recheck and invalidate every existing binding for the bot', async () => {
    const { runtime, runCheck, invalidate } = setup();
    const options = opts();
    options.isolation = await runtime.prepare(key, 'person:alice', f.workspace, options, {});
    const bobWorkspace = f.bot.userOverrides!.bob.workingDirectory!;
    await runtime.prepare(otherKey, 'person:bob', bobWorkspace, opts(bobWorkspace), {});
    const before = options.isolation.fingerprint;
    invalidate.mockClear();
    appendFileSync(binary, '\nfixture binary identity changed\n');
    await expect(runtime.assert(key)).resolves.toBeUndefined();
    expect(runCheck).toHaveBeenCalledTimes(3);
    expect(options.isolation!.fingerprint).not.toBe(before);
    expect(options.isolation).toBe(runtime.policy(key));
    expect(runCheck.mock.calls[2][0].binary).toEqual(identifyBinary(binary));
    expect(verification.get('bot', f.workspace)?.policyFingerprint).toBe(options.isolation!.fingerprint);
    expect(invalidate).toHaveBeenCalledWith(key); expect(invalidate).toHaveBeenCalledWith(otherKey);
    await expect(runtime.assert(key)).resolves.toBeUndefined();
    expect(runCheck).toHaveBeenCalledTimes(3);
  });
  it('a failed forced check invalidates all running scope bindings for that bot', async () => {
    let status: VerificationStatus = 'VERIFIED';
    const runCheck = vi.fn(async (input: IsolationCheckInput) => result(input, status));
    const { runtime, invalidate } = setup(runCheck);
    await runtime.prepare(key, 'person:alice', f.workspace, opts(), {});
    const bobWorkspace = f.bot.userOverrides!.bob.workingDirectory!;
    await runtime.prepare(otherKey, 'person:bob', bobWorkspace, opts(bobWorkspace), {});
    invalidate.mockClear(); status = 'LEAK';
    expect(await runtime.check(key)).toMatchObject({ status: 'LEAK' });
    expect(invalidate).toHaveBeenCalledWith(key); expect(invalidate).toHaveBeenCalledWith(otherKey);
    await expect(runtime.assert(key)).rejects.toThrow();
  });
  it('checker rejection is stored as ERROR and never grants admission', async () => {
    const runCheck = vi.fn(async (_input: IsolationCheckInput): Promise<VerificationRecord> => { throw new Error('injected checker failure'); });
    const { runtime } = setup(runCheck);
    await expect(runtime.prepare(key, 'person:alice', f.workspace, opts(), {})).rejects.toThrow();
    expect(verification.get('bot', f.workspace)).toMatchObject({ status: 'ERROR', checks: [{ name: 'check.execution', status: 'ERROR' }] });
  });
  it('monitor observes a separate doctor store publishing failure and invalidates every bot scope', async () => {
    const { runtime, invalidate } = setup();
    await runtime.prepare(key, 'person:alice', f.workspace, opts(), {});
    const bobWorkspace = f.bot.userOverrides!.bob.workingDirectory!;
    await runtime.prepare(otherKey, 'person:bob', bobWorkspace, opts(bobWorkspace), {});
    invalidate.mockClear();
    const stop = runtime.monitor(10);
    try {
      const external = new VerificationStore(join(f.paths.dataDir, 'isolation/verification.json'));
      external.put({ ...external.get('bot', f.workspace)!, status: 'ERROR', checks: [{ name: 'external-doctor-failure', status: 'ERROR' }] });
      // Separate stores do not share in-process listeners.
      expect(invalidate).not.toHaveBeenCalled();
      await vi.waitFor(() => {
        expect(invalidate).toHaveBeenCalledWith(key);
        expect(invalidate).toHaveBeenCalledWith(otherKey);
      });
    } finally { stop(); }
  });
  it('policy changes without a binary change stay fail-closed without silently rechecking', async () => {
    const { runtime, runCheck } = setup(); const options = opts();
    await runtime.prepare(key, 'person:alice', f.workspace, options, {});
    options.permissionMode = 'bypass';
    await expect(runtime.assert(key)).rejects.toThrow();
    expect(runCheck).toHaveBeenCalledOnce();
  });
  it('concurrent admission checks for one binding share one in-flight verification', async () => {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const runCheck = vi.fn(async (input: IsolationCheckInput) => { await pending; return result(input); });
    const { runtime } = setup(runCheck);
    await runtime.prepare(key, 'person:alice', f.workspace, opts(), {}, false);
    const first = runtime.assert(key); const second = runtime.assert(key);
    await vi.waitFor(() => expect(runCheck).toHaveBeenCalledOnce());
    finish();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(runCheck).toHaveBeenCalledOnce();
  });
});
