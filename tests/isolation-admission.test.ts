import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Transform } from 'node:stream';
import { isolationFixture } from './helpers/isolation.js';
import { VerificationStore, identifyBinary, type VerificationRecord, type VerificationStatus } from '../src/isolation/verification.js';
import { assertIsolationAdmission, ISOLATION_PAUSED } from '../src/isolation/admission.js';
import { agentChildEnv, createCheckOptions } from '../src/isolation/check-options.js';
import { runIsolationCheck } from '../src/isolation/check.js';
import { canResumeIsolated } from '../src/isolation/provenance.js';
import { IsolationRuntime } from '../src/isolation/runtime.js';
import { MemoryStore } from '../src/memory/store.js';
import { SessionStore } from '../src/session/store.js';
import { AgentManager } from '../src/agents/manager.js';
import { ToolGate } from '../src/agents/tool-gate.js';
import type { AgentPlugin, AgentProcess, SpawnOpts } from '../src/types.js';

vi.mock('../src/security/validators.js', () => ({ validateWorkingDirectory: async () => true }));
describe('slice 5 admission and provenance', () => {
  let f: ReturnType<typeof isolationFixture>;
  let verification: VerificationStore;
  let store: SessionStore;
  const key = 'feishu:chat:bot' as const;
  const principal = 'person:alice';
  beforeEach(async () => { f = isolationFixture(); verification = new VerificationStore(join(f.paths.dataDir, 'isolation', 'verification.json')); store = await SessionStore.create(':memory:'); });
  afterEach(() => { vi.restoreAllMocks(); store.close(); rmSync(f.root, { recursive: true, force: true }); });
  const binary = () => identifyBinary('/bin/cat');
  const record = (fingerprint: string, status: VerificationStatus = 'VERIFIED'): VerificationRecord => ({
    bot: 'bot', scopeKey: f.workspace, policyFingerprint: fingerprint, agentBinary: binary(), status,
    checks: [{ name: 'injected fixture', status: 'PASS' }], checkedAt: new Date().toISOString() });
  const context = (fingerprint: string) => ({ bot: 'bot', principal, scope: f.workspace, policyFingerprint: fingerprint, memoryGeneration: 0 });

  it.each(['UNVERIFIED', 'STALE', 'LEAK', 'UNSUPPORTED', 'ERROR'] as const)('denies %s and only permits a current VERIFIED record', status => {
    const policy = f.policy();
    verification.put(record(policy.fingerprint, status));
    expect(() => assertIsolationAdmission({ verification, policy, binary: binary(), expected: context(policy.fingerprint), env: { PATH: '/usr/bin:/bin' } })).toThrow(ISOLATION_PAUSED);
  });
  it.each(['claude-code', 'codex'] as const)('PATH resolution rejects matching legacy VERIFIED policies before and after node creation for %s', async agent => {
    f.bot.agent = agent;
    mkdirSync(join(f.workspace, 'deep/a'), { recursive: true });
    mkdirSync(join(f.workspace, 'bin'));
    symlinkSync(join(f.workspace, 'deep/a'), join(f.workspace, 'up'));
    symlinkSync(join(f.root, 'outside'), join(f.workspace, 'out'));
    symlinkSync(f.workspace, join(f.root, 'alias'));
    const entries = [`${f.workspace}/up/../../bin`, `${f.workspace}//out//missing-bin/`, join(f.root, 'alias', 'bin')];
    expect(realpathSync.native(entries[0])).toBe(join(f.workspace, 'bin'));
    const node = join(f.workspace, 'bin/node');
    expect(existsSync(node)).toBe(false);
    const identity = binary();
    for (const created of [false, true]) {
      if (created) writeFileSync(node, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
      for (const entry of entries) {
        const PATH = `${entry}:/usr/bin:/bin`;
        // Simulate a stored policy accepted by the old validator. PATH and
        // fingerprint match, so rejection cannot rely on either being stale.
        const policy = { ...f.policy(), searchPath: PATH.split(':') };
        verification.put(record(policy.fingerprint));
        const env = { HOME: f.paths.home, PATH };
        const options: SpawnOpts = { workingDirectory: f.workspace, permissionMode: 'blacklist', isolation: policy, env };
        expect(verification.state('bot', f.workspace, policy.fingerprint, identity)).toBe('VERIFIED');
        for (const sessionId of [undefined, 'resume-session']) {
          expect(() => assertIsolationAdmission({ verification, policy, binary: identity, expected: context(policy.fingerprint), env,
            sessionId, provenance: sessionId ? { ...context(policy.fingerprint), agentSessionId: sessionId } : undefined }))
            .toThrow(expect.objectContaining({ status: 'UNSUPPORTED' }));
        }
        expect(() => agentChildEnv(agent, options)).toThrow(/^UNSUPPORTED:.*PATH/);
        expect(() => createCheckOptions(agent, options, env, 'http://127.0.0.1:12345')).toThrow(/^UNSUPPORTED:.*PATH/);
        const prepareTmp = vi.fn();
        const checked = await runIsolationCheck({ bot: 'bot', agent, policy, binary: identity, opts: options, env,
          paths: f.paths, config: f.config }, { prepareTmp });
        expect(checked.status).toBe('UNSUPPORTED');
        expect(checked.checks).toContainEqual({ name: 'environment.path', status: 'UNSUPPORTED' });
        expect(prepareTmp).not.toHaveBeenCalled();
        expect(agentChildEnv(agent, { ...options, isolation: undefined }).PATH).toBe(PATH);
      }
      expect(binary()).toEqual(identity);
    }
  });
  it.each(['claude-code', 'codex'] as const)('canonical PATH survives workspace bin/node creation after VERIFIED for %s', async agent => {
    f.bot.agent = agent; f.config.agents[agent] = { binary: '/bin/cat' };
    const trusted = join(f.paths.installDir, 'bin'); mkdirSync(trusted);
    symlinkSync(process.execPath, join(trusted, 'node'));
    const alias = join(f.workspace, 'trusted-alias'); symlinkSync(trusted, alias);
    const missing = join(f.workspace, 'bin');
    const opts: SpawnOpts = { workingDirectory: f.workspace, permissionMode: 'blacklist',
      env: { HOME: f.paths.home, PATH: `${missing}:${alias}:/usr/bin:/bin` } };
    const expectedPath = [trusted, '/usr/bin', '/bin'].map(p => realpathSync.native(p)).join(':');
    const runCheck = vi.fn(async input => {
      expect(input.env.PATH).toBe(expectedPath);
      expect(agentChildEnv(agent, createCheckOptions(agent, { ...input.opts, isolation: input.policy }, input.env,
        'http://127.0.0.1:12345').opts).PATH).toBe(expectedPath);
      return record(input.policy.fingerprint);
    });
    const runtime = new IsolationRuntime({ config: f.config, paths: f.paths, verification, store,
      memory: new MemoryStore(f.paths.memoryDir), inheritedEnv: {}, sdkVersions: { fixture: '1' }, invalidate: vi.fn(), runCheck });
    opts.isolation = await runtime.prepare(key, principal, f.workspace, opts, {});
    expect(verification.state('bot', f.workspace, opts.isolation.fingerprint, binary())).toBe('VERIFIED');
    expect(opts.env!.PATH).toBe(expectedPath);
    mkdirSync(missing); writeFileSync(join(missing, 'node'), '#!/bin/sh\nexit 99\n', { mode: 0o700 });
    const recorder = runtime.captureRecorder(key); recorder('resume-session');
    for (const sessionId of [undefined, 'resume-session']) {
      await expect(runtime.assert(key, sessionId)).resolves.toBeUndefined();
      const env = agentChildEnv(agent, opts);
      expect(env.PATH).toBe(expectedPath);
      const child = spawnSync('/usr/bin/env', ['node', '-p', '"trusted-node"'], { cwd: f.workspace, env, encoding: 'utf8' });
      expect(child.status).toBe(0); expect(child.stdout.trim()).toBe('trusted-node');
    }
    await runtime.check(key);
    expect(runCheck).toHaveBeenCalledTimes(2);
  });
  it('persists 600 records, detects binary/policy staleness and fails closed without overwriting corruption', () => {
    const p = f.policy();
    expect(verification.state('bot', p.scopeKey, p.fingerprint, binary())).toBe('UNVERIFIED');
    verification.put(record(p.fingerprint));
    const path = join(f.paths.dataDir, 'isolation', 'verification.json');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const reopened = new VerificationStore(path);
    expect(reopened.state('bot', p.scopeKey, p.fingerprint, binary())).toBe('VERIFIED');
    expect(reopened.state('bot', p.scopeKey, 'changed', binary())).toBe('STALE');
    expect(reopened.state('bot', p.scopeKey, p.fingerprint, { ...binary(), size: 1 })).toBe('STALE');
    writeFileSync(path, 'damaged');
    expect(reopened.state('bot', p.scopeKey, p.fingerprint, binary())).toBe('ERROR');
    expect(() => reopened.put(record(p.fingerprint))).toThrow('unreadable');
    expect(readFileSync(path, 'utf8')).toBe('damaged');
  });
  it.each(['bot', 'principal', 'scope', 'policyFingerprint', 'memoryGeneration'] as const)('rejects provenance mismatch: %s', field => {
    const expected = context('policy');
    expect(canResumeIsolated(undefined, expected)).toBe(false);
    const valid = { ...expected, agentSessionId: 'session' };
    expect(canResumeIsolated(valid, expected)).toBe(true);
    expect(canResumeIsolated({ ...valid, [field]: field === 'memoryGeneration' ? 1 : 'other' }, expected)).toBe(false);
  });
  it('keeps immutable provenance across database reopen and does not relabel an old session', async () => {
    const path = join(f.paths.dataDir, 'sessions.db'); const db = await SessionStore.create(path);
    const p = { ...context('policy'), agentSessionId: 'history' };
    db.putProvenance(p); db.close();
    const reopened = await SessionStore.create(path);
    expect(reopened.getProvenance('bot', 'history')).toEqual(p);
    expect(() => reopened.putProvenance({ ...p, memoryGeneration: 1 })).toThrow('Conflicting');
    expect(reopened.getProvenance('bot', 'history')).toEqual(p); reopened.close();
  });
  it('keeps VERIFIED admission across /model, reasoning, agentsFile and per-message changes', async () => {
    const invalidate = vi.fn(); const replaceProcess = vi.fn();
    const runtime = new IsolationRuntime({ config: f.config, paths: f.paths, verification, store,
      memory: new MemoryStore(f.paths.memoryDir), inheritedEnv: { PATH: '/bin', HOME: f.paths.home }, sdkVersions: { fixture: '1' }, invalidate, replaceProcess });
    const opts: SpawnOpts = { workingDirectory: f.workspace, permissionMode: 'blacklist', model: 'model-a',
      reasoningEffort: 'low', appendSystemPrompt: 'instructions-a', systemPrompt: 'system-a', initialPrompt: 'message-a',
      env: { CTI_SENDER_ID: 'alice', HTTPS_PROXY: 'http://fixture-a.invalid', LANG: 'en_US.UTF-8' } };
    const initial = await runtime.prepare(key, principal, f.workspace, opts, {}, false);
    verification.put(record(initial.fingerprint));
    const variants: Partial<SpawnOpts>[] = [
      { model: 'model-b' }, { reasoningEffort: 'high' }, { appendSystemPrompt: 'instructions-b' },
      { systemPrompt: 'system-b' }, { initialPrompt: 'message-b', turnTimeoutMs: 1000, idleTimeoutMs: 500 },
      { env: { TMPDIR: initial.tmpdir, CTI_SENDER_ID: 'bob', CTI_SENDER_NAME: 'fixture', HTTPS_PROXY: 'http://fixture-b.invalid', TERM: 'dumb' } },
    ];
    f.bot.agentsFile = join(f.root, 'maintained.md'); writeFileSync(f.bot.agentsFile, 'new instructions');
    for (const changes of variants) {
      Object.assign(opts, changes);
      await expect(runtime.assert(key)).resolves.toBeUndefined();
      const next = await runtime.prepare(key, principal, f.workspace, opts, {});
      expect(next.fingerprint).toBe(initial.fingerprint);
      expect(verification.state('bot', f.workspace, next.fingerprint, binary())).toBe('VERIFIED');
    }
    expect(invalidate).not.toHaveBeenCalled(); expect(replaceProcess).not.toHaveBeenCalled();
  });
  it.each(['sandboxMode', 'permissionMode', 'autoApprove', 'addDirs', 'sandbox', 'sandboxBoxRoots',
    'sandboxOtherProtectedRoots', 'envKeys'] as const)('invalidates admission when isolation parameter %s changes', async field => {
    const invalidate = vi.fn();
    const runtime = new IsolationRuntime({ config: f.config, paths: f.paths, verification, store,
      memory: new MemoryStore(f.paths.memoryDir), inheritedEnv: { PATH: '/bin', HOME: f.paths.home }, sdkVersions: { fixture: '1' }, invalidate });
    const opts: SpawnOpts = { workingDirectory: f.workspace, permissionMode: 'blacklist' };
    const initial = await runtime.prepare(key, principal, f.workspace, opts, {}, false);
    verification.put(record(initial.fingerprint));
    if (field === 'sandboxMode') opts.sandboxMode = 'read-only';
    if (field === 'permissionMode') opts.permissionMode = 'bypass';
    if (field === 'autoApprove') opts.autoApprove = true;
    if (field === 'addDirs') opts.addDirs = [join(f.root, 'reference')];
    if (field === 'sandbox') opts.sandbox = 'off';
    if (field === 'sandboxBoxRoots') opts.sandboxBoxRoots = [f.root];
    if (field === 'sandboxOtherProtectedRoots') opts.sandboxOtherProtectedRoots = [f.root];
    if (field === 'envKeys') opts.env = { ...opts.env, XDG_STATE_HOME: join(f.root, 'agent-state') };
    await expect(runtime.assert(key)).rejects.toThrow(ISOLATION_PAUSED);
    const changed = await runtime.prepare(key, principal, f.workspace, opts, {}, false, true);
    expect(changed.fingerprint).not.toBe(initial.fingerprint);
    expect(verification.state('bot', f.workspace, changed.fingerprint, binary())).toBe('STALE');
    expect(invalidate).toHaveBeenCalledWith(key);
  });
  it('changing the bridge-owned Codex home invalidates verification and old session provenance', async () => {
    const runtime = new IsolationRuntime({ config: f.config, paths: f.paths, verification, store,
      memory: new MemoryStore(f.paths.memoryDir), inheritedEnv: { PATH: '/bin', HOME: f.paths.home }, sdkVersions: { fixture: '1' }, invalidate: vi.fn() });
    const opts: SpawnOpts = { workingDirectory: f.workspace, permissionMode: 'blacklist' };
    const initial = await runtime.prepare(key, principal, f.workspace, opts, {}, false);
    verification.put(record(initial.fingerprint));
    const previous = { ...context(initial.fingerprint), agentSessionId: 'old' };
    f.paths.dataDir = join(f.root, 'moved-bridge');
    const next = await runtime.prepare(key, principal, f.workspace, opts, {}, false, true);
    expect(next.codexHome).not.toBe(initial.codexHome);
    expect(verification.state('bot', f.workspace, next.fingerprint, binary())).toBe('STALE');
    expect(canResumeIsolated(previous, context(next.fingerprint))).toBe(false);
  });

  it('integration: manager gates spawn/resume, failure kills live children, forgetting rejects old generations', async () => {
    const memory = new MemoryStore(f.paths.memoryDir);
    const manager = new AgentManager(new ToolGate([]), () => {});
    const children: AgentProcess[] = [];
    const spawn = vi.fn(() => {
      const proc = Object.assign(new EventEmitter(), { pid: 1, sessionId: '', stdin: new PassThrough(), stdout: new PassThrough(), kill: vi.fn() }) as AgentProcess;
      children.push(proc); return proc;
    });
    const plugin = { name: 'codex', displayName: 'fixture', capabilities: { streamJson: true, sessionResume: true, permissionPrompt: false, gracefulCancel: false, slashCommands: [] },
      spawn, resume: vi.fn(spawn), createStdoutParser: () => new Transform({ objectMode: true, transform(c, _e, cb) { cb(null, c); } }), formatStdinMessage: () => '',
      buildSpawnArgs: () => [], formatPermissionResponse: () => '' } as unknown as AgentPlugin;
    manager.registerPlugin(plugin);
    const invalidated = vi.fn((k: import('../src/types.js').SessionKey) => manager.forgetSession(k));
    const runtime = new IsolationRuntime({ config: f.config, paths: f.paths, verification, store, memory,
      inheritedEnv: { PATH: '/bin', HOME: f.paths.home }, prepareTmp: async policy => { mkdirSync(policy.tmpdir, { recursive: true, mode: 0o700 }); }, sdkVersions: { fixture: '1' }, invalidate: invalidated });
    manager.setIsolationGuard((k, opts, id) => runtime.guardStart(k, opts, id));
    const opts: SpawnOpts = { workingDirectory: f.workspace, permissionMode: 'blacklist' };
    const handlers = { onEvent: vi.fn(), onToolBlocked: vi.fn(), onPermissionTimeout: vi.fn(), onProcessExit: vi.fn() };
    opts.isolation = await runtime.prepare(key, principal, f.workspace, opts, {}, false);
    await expect(manager.spawnAgent(key, 'codex', opts, handlers)).rejects.toThrow(ISOLATION_PAUSED);
    expect(spawn).not.toHaveBeenCalled();
    verification.put(record(opts.isolation.fingerprint));
    await manager.spawnAgent(key, 'codex', opts, handlers);
    const capture = runtime.captureRecorder(key); capture('old');
    expect(await runtime.canResume(key, 'old')).toBe(true);
    manager.forgetSession(key);
    await manager.resumeAgent(key, 'codex', 'old', opts, handlers);
    verification.put(record(opts.isolation.fingerprint, 'LEAK'));
    expect(manager.hasProcess(key)).toBe(false);
    expect(children.at(-1)!.kill).toHaveBeenCalledWith('SIGTERM');
    verification.put(record(opts.isolation.fingerprint));
    const entry = await memory.add(principal, 'actor', 'remember');
    await memory.forget(principal, entry.id, () => true);
    expect(await runtime.canResume(key, 'old')).toBe(false);
    await expect(manager.resumeAgent(key, 'codex', 'old', opts, handlers)).rejects.toThrow();
    opts.isolation = await runtime.prepare(key, principal, f.workspace, opts, {});
    await expect(manager.resumeAgent(key, 'codex', 'old', opts, handlers)).rejects.toThrow('已被撤销');
    expect(await runtime.listDomain({ bot: 'bot', principal, scope: f.workspace, policyFingerprint: opts.isolation.fingerprint })).toEqual([]);
    await manager.spawnAgent(key, 'codex', opts, handlers);
    runtime.captureRecorder(key)('new'); expect(store.getProvenance('bot', 'new')?.memoryGeneration).toBe(1);
    // A late callback must retain its original generation, never adopt a new binding.
    capture('late-old'); expect(store.getProvenance('bot', 'late-old')?.memoryGeneration).toBe(0);
    manager.forgetSession(key);
  });
});
